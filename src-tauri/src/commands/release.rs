//! Handing back per-app endpoint assignments this run is not using.
//!
//! Two walks with one deliberate difference between them.
//!
//! [`reset_pinned_endpoints`] is the button in the settings page. It releases the
//! assignment of **every** program that holds an audio session and is not held by
//! a live route, walking the render and the capture flow together, and it cannot
//! tell what this app wrote from what the user set by hand in the volume mixer —
//! the service keeps no author field, `PinnedRoutes` is only this run's memory.
//! The wording says so and the behaviour is not surgical; do not "narrow" it.
//!
//! [`release_stale_routes`] is housekeeping: the session refresh that notices a
//! routed program has gone, and the startup pass just before the restores. It
//! reaches only what this app booked, frees the **render** flow alone (a capture
//! half belongs to a feed, and the relaunched process may be a feed target right
//! now), and reports failures into the log rather than to the user, because both
//! of its callers are housekeeping rather than a request.
//!
//! Both keep the bookkeeping closed: an entry is dropped only when the service
//! answered that it released, and an assignment this run could not hand back
//! stays on the book so the exit walk and the next sweep can reach it again.

use std::collections::{HashMap, HashSet};

use log::{info, warn};
use tauri::{AppHandle, State};

use crate::audio;
use crate::audio::duplication::DuplicationManager;
use crate::audio::routing::{PinnedRoutes, ReleaseOutcome};
use crate::config::{FeedCarrierConfig, FeedConfig};

use super::taps::resume_feed_taps;
use super::ResetOutcome;

/// Release the per-app assignments this app is not using right now.
///
/// Every program an earlier version routed keeps an assignment Windows applies
/// before the system default, and while it is there the program ignores device
/// switches made by hand. This is the way out: it walks the programs that hold
/// an audio session — the only ones the policy API can be asked about, because
/// it addresses them by PID — and releases the ones no live route is using.
#[tauri::command]
pub async fn reset_pinned_endpoints(
    duplications: State<'_, DuplicationManager>,
    pins: State<'_, PinnedRoutes>,
) -> Result<ResetOutcome, String> {
    info!("cmd: reset_pinned_endpoints");
    let sessions = tokio::task::spawn_blocking(audio::sessions::enumerate_sessions)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    let routed: HashSet<u32> = duplications
        .active_routes()
        .into_iter()
        .map(|route| route.pid)
        .collect();
    // The assignment is stored per executable, so releasing through *any*
    // process of a routed program would reach the live route's primary
    // endpoint — including through a sibling PID that was never routed
    // itself. Whole executables with a live route are therefore out of
    // bounds, whatever state their individual processes are in.
    let routed_exes: HashSet<String> = {
        let mut exes: HashSet<String> = duplications
            .routed_exe_names()
            .into_iter()
            .map(|name| name.to_ascii_lowercase())
            .collect();
        // "Live route" is `is_routed`'s question, not the book's: an entry whose
        // process is gone, or whose pid the kernel recycled, holds nothing on
        // purpose. Read as a route, it would speak for its executable here and
        // hide that program's assignments from the reset for good — the reset is
        // exactly where a program this run handed back to the default (because
        // Windows refused to release it at stop time) has to be reachable.
        for (pid, exe_name, _device) in pins.snapshot() {
            if pins.is_routed(pid) {
                exes.insert(exe_name.to_ascii_lowercase());
            }
        }
        exes
    };
    let pids: Vec<u32> = sessions
        .iter()
        // The system-sounds session holds no assignment of ours and the release
        // walk answers nothing for it; asking anyway would make the sweep's count
        // of programs it was asked about disagree with the count it can report on.
        .filter(|session| session.pid != 0)
        .filter(|session| !routed.contains(&session.pid) && !pins.is_routed(session.pid))
        // The enumeration already read every one of these names; asking the
        // process again would be an OpenProcess per session for the same answer.
        .filter(|session| !routed_exes.contains(&session.exe_name.to_ascii_lowercase()))
        .map(|session| session.pid)
        .collect();

    let names: HashMap<u32, String> = sessions
        .into_iter()
        .map(|session| (session.pid, session.exe_name))
        .collect();

    let outcomes = audio::routing::release_process_default_devices(pids, audio::Role::All)
        .await
        .map_err(|e| e.to_string())?;

    let mut released = 0;
    let mut still_pinned = Vec::new();
    let mut still_pinned_devices: Vec<Option<String>> = Vec::new();
    for (pid, outcome) in outcomes {
        match outcome {
            ReleaseOutcome::Released => {
                // Nothing pins this program any more, so its bookkeeping goes
                // too — including the entry of a route that was handed back at
                // stop time and is only now really released, and any feed pin
                // whose endpoints the sweep just cleared.
                pins.forget(pid);
                pins.forget_feed_source(pid);
                pins.forget_feed_capture(pid);
                released += 1;
            }
            other => {
                // Keep the device it is still fixed to when the service told us,
                // and `None` when it would not answer — both are refusals, but
                // only one can name the endpoint to the user.
                let device = match other {
                    ReleaseOutcome::StillPinned(device) => Some(device),
                    _ => None,
                };
                still_pinned.push(
                    names
                        .get(&pid)
                        .cloned()
                        .unwrap_or_else(|| format!("PID {pid}")),
                );
                still_pinned_devices.push(device);
            }
        }
    }
    info!(
        "reset: released {released} assignment(s), {} left",
        still_pinned.len()
    );
    Ok(ResetOutcome {
        released,
        still_pinned,
        still_pinned_devices,
    })
}

/// Release assignments whose program exited while it was routed.
///
/// A routed program can quit by itself, and the assignment it was given then
/// outlives it: the next launch would play to the old device and ignore the
/// system default, with no route on screen to explain why. The API addresses
/// programs by PID, so a stale assignment is handed to the program's new
/// process; one that is not running yet keeps its entry for a later sweep. A
/// new process that is itself being routed right now already owns that
/// assignment, so it is left alone.
///
/// A route that ends this way frees its executable's render slot exactly as a
/// stop would, so the feeds that were waiting on it are resumed here too.
///
/// Returns the executable names that were released, for the log.
///
/// A program this sweep could not hand back is logged, not surfaced, and that is
/// the reporting rule on purpose: both of this command's callers are housekeeping
/// rather than a request — the session refresh that notices a routed program has
/// gone, and the startup pass that runs just before the restores — so the rule
/// "a failure the user just caused goes to the user" does not reach it. An `Err`
/// would be worse than the log line, not better: the frontend swallows this
/// answer whole, so a refusal turned into an error loses the names that *were*
/// released too. The user-initiated cleanup is [`reset_pinned_endpoints`], and
/// that one answers with what is still pinned and on which device.
#[tauri::command]
pub async fn release_stale_routes(
    pins: State<'_, PinnedRoutes>,
    feeds: State<'_, FeedConfig>,
    carrier: State<'_, FeedCarrierConfig>,
    app: AppHandle,
) -> Result<Vec<String>, String> {
    let pinned = pins.snapshot();
    if pinned.is_empty() {
        return Ok(Vec::new());
    }
    let sessions = tokio::task::spawn_blocking(audio::sessions::enumerate_sessions)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    let live_pids: HashSet<u32> = sessions.iter().map(|session| session.pid).collect();
    // The system-sounds session (PID 0) is not a process the service will answer
    // for, so it must never be the sibling this sweep hands the assignment to: the
    // release walk skips it and returns no outcome at all, which the guard below
    // would otherwise read as a clean release.
    let live_by_exe = smallest_pid_per_exe(
        sessions
            .iter()
            .map(|session| (session.exe_name.as_str(), session.pid)),
    );
    // Snapshot, not the live map: the sweep below drops entries as it goes, and
    // a PID it drops is never the one it is about to hand the assignment to.
    // Kind only, with no liveness witness, and used for one question at the end:
    // whether the entry this sweep is dropping *was* a route, so its executable's
    // render slot came free. The pid is a dead process by the time it is asked,
    // so the witnessed question would always answer no and no feed would resume.
    let ours: HashSet<u32> = pins.routed_pids().into_iter().collect();
    // The assignment is stored per executable, and the PID it would be handed to
    // need not be the PID of ours. What decides is whether that *executable*
    // still has a live route of ours: clearing it through any of its processes
    // would take that route's primary endpoint away, leaving the mirrors playing
    // while the program quietly fell back to the system default.
    //
    // `is_routed` carries the witness, so a route whose program is alive but
    // simply quiet right now — no session in the enumeration above — still holds
    // its executable here. Presence of a session was never the question.
    let mut routed_exes: HashSet<String> = HashSet::new();
    for (pid, exe_name, _) in &pinned {
        if pins.is_routed(*pid) {
            routed_exes.insert(exe_name.to_ascii_lowercase());
        }
    }

    let mut released: Vec<String> = Vec::new();
    // Programs this sweep could not hand back. The sweep is best effort — one
    // refusal, or a release walk that could not be asked at all, must not leave
    // the remaining stale pins standing, nor skip the feed cleanup and the
    // resumes below — so a failure is collected and said out loud instead of
    // ending the walk with `?`.
    let mut not_released: Vec<String> = Vec::new();
    // Executables whose *route* entry went back: freeing the render slot is the
    // same moment a stop frees it, so the feeds waiting on it resume here too.
    let mut routes_ended: Vec<String> = Vec::new();
    for (pid, exe_name, _device) in pinned {
        if live_pids.contains(&pid) {
            // Still the process we pinned; its route is live.
            continue;
        }
        let Some(&relaunched_pid) = live_by_exe.get(&exe_name.to_ascii_lowercase()) else {
            continue;
        };
        // The service stores the assignment per executable, so clearing it
        // through the new process would also clear one this app is routing
        // *right now* — the mirrors would keep playing while the primary
        // silently fell back to the system default. That route owns the
        // assignment now; only the stale bookkeeping is ours to drop.
        if pins.is_routed(relaunched_pid) || routed_exes.contains(&exe_name.to_ascii_lowercase()) {
            pins.forget(pid);
            continue;
        }
        // The entry being swept is a route's, and a route owns only the *render*
        // flow. The relaunched process may well be a feed target right now —
        // that program has no live route, which is why this branch was reached —
        // and clearing its capture half here would silence the feed while the
        // pin stayed on the books and the board kept drawing it delivered. Only
        // the settings reset and app exit are allowed to walk both flows.
        match audio::routing::release_process_default_devices_flow(
            vec![relaunched_pid],
            audio::Role::All,
            false,
        )
        .await
        {
            // One pid asked, one answer taken: an empty list would satisfy `all()`
            // without the service having said anything, and the sweep would forget
            // an entry for an assignment that is still standing.
            Ok(outcomes)
                if outcomes.len() == 1
                    && outcomes
                        .iter()
                        .all(|(_, outcome)| *outcome == ReleaseOutcome::Released) =>
            {
                pins.forget(pid);
                info!("released the assignment {exe_name} was left on by an earlier route");
                if ours.contains(&pid) && !routes_ended.contains(&exe_name) {
                    routes_ended.push(exe_name.clone());
                }
                // Several stale PIDs can share one executable; the log wants the
                // name once, not once per PID.
                if !released.contains(&exe_name) {
                    released.push(exe_name);
                }
            }
            Ok(outcomes) => {
                // Windows kept the assignment (or would not confirm it clear), so
                // the entry stays on the book: exit cleanup and the next sweep
                // both reach it again.
                let reason = outcomes
                    .iter()
                    .map(|(_, outcome)| match outcome {
                        ReleaseOutcome::StillPinned(device) => format!("still fixed to {device}"),
                        // Not a refusal from the service — this run never asked. The
                        // entry stays on the book either way and the next sweep
                        // reaches it, but the line has to say which of the two
                        // happened, or a route the user made a moment ago reads as
                        // an audio service that would not answer.
                        ReleaseOutcome::Superseded => {
                            "a newer write took the slot first".to_string()
                        }
                        _ => "not confirmed clear".to_string(),
                    })
                    .collect::<Vec<_>>()
                    .join("; ");
                warn!("the sweep left {exe_name} pinned through PID {relaunched_pid}: {reason}");
                if !not_released.contains(&exe_name) {
                    not_released.push(exe_name);
                }
            }
            Err(e) => {
                warn!("the sweep could not ask about {exe_name}: {e}");
                if !not_released.contains(&exe_name) {
                    not_released.push(exe_name);
                }
            }
        }
    }
    if !not_released.is_empty() {
        warn!(
            "the sweep released {} assignment(s) and could not reach {}: {}",
            released.len(),
            not_released.len(),
            not_released.join(", ")
        );
    }
    // Feed pins whose program is gone are bookkeeping with nothing to hold: the
    // endpoints they named died with the process. The rule itself stays in the
    // feed memory — it is the user's, not the process's — so the sweep drops
    // only the pin. Alive-but-sessionless programs keep theirs: the process
    // table decides, not the render-session walk above.
    pins.forget_dead_feed_pins();
    // After the dead pins are off the book, so nothing here re-points a
    // process that has stopped needing it.
    for exe in &routes_ended {
        resume_feed_taps(exe, &feeds, &carrier, &pins, &app).await;
    }
    Ok(released)
}

/// Fold the session list down to one PID per executable: the smallest one that
/// is a process at all.
///
/// The product rule is one executable routes one process, and the process it
/// routes is the smallest pid of that name — that is the pid the frontend's
/// route entry is keyed by. Taken as whichever session the enumeration happened
/// to list first, the sweep would hand a stale assignment to an arbitrary
/// sibling and could pick a different one on the next run of the same machine.
/// Keys are lower-cased, because the name on a session is whatever case the
/// launch used.
///
/// PID 0 is the system-sounds session and is never folded in: it names no
/// process, and the audio service will not speak for it, so a sweep that picked
/// it would be answered with no outcome at all.
fn smallest_pid_per_exe<'a>(
    sessions: impl Iterator<Item = (&'a str, u32)>,
) -> HashMap<String, u32> {
    let mut by_exe: HashMap<String, u32> = HashMap::new();
    for (exe_name, pid) in sessions.filter(|(_, pid)| *pid != 0) {
        by_exe
            .entry(exe_name.to_ascii_lowercase())
            .and_modify(|smallest| *smallest = (*smallest).min(pid))
            .or_insert(pid);
    }
    by_exe
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The sweep releases a stale assignment by asking the audio service through
    /// one of the program's live processes, and the product routes one executable
    /// through its smallest pid. Folded by whichever session was enumerated first,
    /// the same machine walked twice could reach two different siblings, and the
    /// one the route entry is keyed by would be the one left out.
    ///
    /// PID 0 is the system-sounds session, which names no process at all: the
    /// release walk skips it and answers nothing, so folding it in would hand the
    /// sweep a pid it can never get a verdict on.
    #[test]
    fn one_executable_is_handed_the_smallest_of_its_pids() {
        let by_exe = smallest_pid_per_exe(
            [
                ("Chrome.exe", 4100u32),
                ("chrome.exe", 900),
                ("Game.exe", 70),
                ("System", 0),
            ]
            .into_iter(),
        );
        assert_eq!(by_exe.get("chrome.exe"), Some(&900));
        assert_eq!(by_exe.get("game.exe"), Some(&70));
        assert_eq!(
            by_exe.get("system"),
            None,
            "the system-sounds session is no process to hand an assignment to"
        );
        assert_eq!(
            by_exe.len(),
            2,
            "one entry per executable, whatever the case"
        );
    }
}
