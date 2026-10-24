//! Apply a device route, stop one, and the live engines the board reads.
//!
//! The head of the device list is the process's native endpoint (all roles) and
//! every further device gets a duplicated copy, so a single-device route needs no
//! engine unless it also carries a feed tap. A route owns the **render** flow only:
//! stopping one releases that half and puts the program's feed tap back on an
//! engine of its own (see [`super::taps`]). Every write is booked in `PinnedRoutes`
//! as it lands, and every path that does not leave the route standing hands it back
//! or marks it abandoned, so the assignment stays reachable by the sweep, the reset
//! and the exit walk. System-critical processes are refused deeper down, not here.

use std::collections::HashSet;

use log::{info, warn};
use tauri::{AppHandle, Manager, State};

use crate::audio;
use crate::audio::duplication::DuplicationManager;
use crate::audio::routing::{PinnedRoutes, ReleaseOutcome};
use crate::config::{FeedCarrierConfig, FeedConfig, RouteConfig};

use super::identity::{exe_name_of, require_exe_name};
use super::outcomes::superseded_release;
use super::taps::{feed_tap_for, resume_feed_taps};
use super::StopOutcome;

/// Route a process to an ordered list of devices.
///
/// The first device becomes the process's native endpoint (all roles); every
/// further device receives a duplicated copy of the stream. When only one
/// device is given, any running duplication engine for the process is stopped.
///
/// Each device's configured delay is measured against the app's audio, so the
/// engine also needs the primary device's value: the earliest device of the
/// group is the reference the copies are held back from. The order the list
/// arrives in is the user's, not the delays' — its head is the primary.
// Tauri commands carry their State params in the signature, so the argument
// count is fixed by the framework.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn apply_route(
    pid: u32,
    exe_name: String,
    device_ids: Vec<String>,
    remember: bool,
    config: State<'_, RouteConfig>,
    pins: State<'_, PinnedRoutes>,
    feeds: State<'_, FeedConfig>,
    carrier: State<'_, FeedCarrierConfig>,
    app: AppHandle,
) -> Result<u64, String> {
    info!("cmd: apply_route pid={pid} exe={exe_name} devices={device_ids:?} remember={remember}");
    // PID 0 is the system-sounds session. The endpoint write below refuses it, but
    // refusing at the boundary is what keeps the *rollback* honest: the release
    // walk answers nothing at all for PID 0, and an empty outcome list is the one
    // thing an `.all()` over outcomes reads as "everything came back".
    if pid == 0 {
        return Err("a route needs a process".to_string());
    }
    require_exe_name("a route", &exe_name)?;
    if device_ids.is_empty() {
        return Err("no devices selected".to_string());
    }
    // A device named twice would be mirrored onto the very device the OS is
    // already playing natively: the program is then heard twice, offset by the
    // copy's own latency, which sounds like an echo rather than like a second
    // output. A remembered route read back from a hand-edited config is one way
    // to arrive here, so the check belongs at the boundary.
    let device_ids = dedupe_device_ids(device_ids);
    // Every id in the list crosses into COM, just not all through the same door:
    // the head is validated inside the endpoint write below, the rest are opened
    // by the engine as mirrors and never pass through it. A blank or absurd id
    // among the copies would be a route the board draws and no device answers,
    // so the whole list is checked here, at the boundary, before anything is
    // written and before any pin is booked.
    for (index, device_id) in device_ids.iter().enumerate() {
        audio::routing::validate_device_id(device_id)
            .map_err(|e| format!("device {} of this route is not usable: {e}", index + 1))?;
    }

    // Primary: the OS-native per-app endpoint.
    audio::routing::set_process_default_device(&device_ids[0], pid, audio::Role::All)
        .await
        .map_err(|e| e.to_string())?;
    // Remember that this assignment is ours: the audio service stores it per
    // executable, so it has to be released again when the route stops or the
    // app quits instead of being left behind on the user's machine.
    pins.mark(pid, &exe_name, &device_ids[0]);

    // Mirrors: software duplication to every further device. The engine reads
    // each device's configured delay and volume itself.
    //
    // The teardown and the start are blocking walks of every device and every
    // session — the session volume the old engine hands back and the new one
    // claims — and AudioSrv answers them slowly while, say, a Bluetooth
    // endpoint reconnects. Off the runtime's worker, or every command behind
    // this one waits out those seconds with it.
    let started = {
        let engine_app = app.clone();
        let exe = exe_name.clone();
        let primary = device_ids[0].clone();
        let mirrors = device_ids[1..].to_vec();
        // A programme that feeds another one carries its tap into every engine
        // it starts: the feed is a second destination, not a state the route
        // replaces, so applying a route must not cut the wire it already has.
        let feed_tap = feed_tap_for(&exe_name, &feeds, &carrier);
        tokio::task::spawn_blocking(move || {
            let duplications = engine_app.state::<DuplicationManager>();
            duplications.stop(pid);
            if mirrors.is_empty() && feed_tap.is_none() {
                return Ok(0);
            }
            // A single-device route runs an engine only to carry its feed tap,
            // and `active_routes` deliberately leaves such an engine out: it
            // serves no device of the board. Answering with its generation
            // would tell the frontend the route is engine-backed, and the next
            // reconciliation — which does not find it in the engine list —
            // would retire the badge of a route that is playing perfectly well
            // on Windows' own endpoint.
            let tap_only = mirrors.is_empty();
            let generation =
                duplications.start(pid, &exe, &primary, mirrors, feed_tap, &engine_app)?;
            Ok(if tap_only { 0 } else { generation })
        })
        .await
        // A thread that panicked mid-start counts as a failed start, not as a
        // reason to answer before the rollback below: the primary endpoint is
        // already written and its pin already booked, so returning here would
        // leave the program playing on that device with no live route for the
        // board to stop — the very dead end `mark_abandoned` exists to close.
        .unwrap_or_else(|e| Err(audio::AudioError::Api(e.to_string())))
    };
    let generation = match started {
        Ok(generation) => generation,
        Err(e) => {
            // The mirrors are what failed, but the primary write above has
            // already landed and its pin is booked. Left standing, the
            // program keeps playing on the chosen device while the board
            // shows no route to stop — the dead end `mark_abandoned` exists
            // to close. Undo this command's own steps before reporting.
            warn!("starting the duplication engine for PID {pid} failed: {e}");
            match audio::routing::release_process_default_devices_flow(
                vec![pid],
                audio::Role::All,
                false,
            )
            .await
            {
                // One pid asked, one answer required: the walk skips a pid it will
                // not speak for and returns nothing at all, and "nothing said" is
                // not "handed back" — the pin would be forgotten while the program
                // kept playing on the device this command chose.
                Ok(outcomes)
                    if outcomes.len() == 1
                        && outcomes.iter().all(|(_, o)| *o == ReleaseOutcome::Released) =>
                {
                    pins.forget(pid);
                    // The route is gone and the engine with it, so the feeds
                    // this programme sends go back on their own engine — the
                    // wire into the carrier is not a route's property.
                    resume_feed_taps(&exe_name, &feeds, &carrier, &pins, &app).await;
                }
                Ok(outcomes) if superseded_release(&outcomes) => {
                    // Somebody asked for this program's slot after this route did,
                    // and that write — not this one — owns the endpoint now. The
                    // fallback below would point the program at the default device
                    // over their heads, so the slot stays where the newer write put
                    // it and only this command's own bookkeeping is corrected: the
                    // entry must come off `Route`, because the engine never started
                    // and the board will not show a route to stop. Left standing it
                    // would hide the assignment from the settings reset, which is
                    // now the only path that can reach it.
                    warn!(
                        "the rollback of PID {pid} was superseded; the assignment stays with the newer write"
                    );
                    pins.mark_abandoned(pid);
                }
                _ => {
                    // The release did not take, so the assignment is still
                    // ours — but no live route answers for it any more.
                    // Do what a stop does in this spot: fall back to the
                    // default device, or admit the pin is beyond this
                    // run's reach so the settings reset can still find it.
                    pin_to_default_or_abandon(pid, &pins).await;
                }
            }
            return Err(e.to_string());
        }
    };

    if remember {
        config.save_route(&exe_name, &device_ids)?;
        info!("remembered route: {exe_name} -> {device_ids:?}");
    }
    Ok(generation)
}

/// Drop repeated device ids, keeping each id at the position it first appeared.
///
/// The position is what decides the primary, so a repeat is dropped rather than
/// the list being sorted or reversed into a shape the caller did not ask for.
fn dedupe_device_ids(device_ids: Vec<String>) -> Vec<String> {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut unique = Vec::with_capacity(device_ids.len());
    for id in &device_ids {
        if !seen.insert(id.as_str()) {
            warn!("apply_route: {id} was named twice; the route uses it once");
            continue;
        }
        unique.push(id.clone());
    }
    unique
}

/// Stop routing a process: halt any duplication engine and hand the program
/// back to the system default device.
///
/// "Back to the default" used to mean *writing* the default device into the
/// program's per-app assignment, which left it pinned there for good: Windows
/// then ignored every later change of the default device for that program, so
/// switching devices by hand stopped working — the bug this fixes. The
/// assignment is released instead, so the program follows the default again,
/// now and after the user picks another one.
#[tauri::command]
pub async fn stop_route(
    pid: u32,
    duplications: State<'_, DuplicationManager>,
    pins: State<'_, PinnedRoutes>,
    feeds: State<'_, FeedConfig>,
    carrier: State<'_, FeedCarrierConfig>,
    app: AppHandle,
) -> Result<StopOutcome, String> {
    info!("cmd: stop_route pid={pid}");
    // PID 0 is the system-sounds session and nothing this app can route (the
    // write path refuses it), but the release path does not stop there: it skips
    // the PID and answers with no outcomes at all, which the check below would
    // read as "nothing left to hand back" — a stop reported as done for a step
    // that never ran.
    if pid == 0 {
        return Err("a stop needs a process".to_string());
    }
    // The engine comes down first, before the lookup below can hold this command
    // for a round trip. The frontend has already cleared the badge optimistically
    // and anything that reconciles against the live engines in that window would
    // read the engine this stop is removing and put the badge back — and the
    // `stopped` event that follows is ignored on purpose as redundant.
    //
    // But the release below is decided *before* the engine goes: it is what
    // knows the executable, and the question it answers — does a sibling
    // process of this program still hold a live route? — is a question about
    // the moment before the teardown.
    let released_exe = duplications
        .exe_name_of(pid)
        .or_else(|| pins.exe_name_of(pid));
    let sibling_routed = match &released_exe {
        Some(exe) => {
            duplications.exe_duplicated_elsewhere(pid) || pins.exe_routed_elsewhere(pid, exe)
        }
        None => false,
    };
    // Handing the program's session volume back is a blocking walk of every
    // device and every session, and AudioSrv is slow about it while an endpoint
    // reconnects — off the runtime's worker, the way `apply_route` does it.
    //
    // A teardown thread that panics is reported and then walked past: the
    // endpoint is still ours until the release below hands it back, and answering
    // early would strand the assignment on that device with no engine running and
    // no route left for the board to stop.
    let teardown_app = app.clone();
    if let Err(e) =
        tokio::task::spawn_blocking(move || teardown_app.state::<DuplicationManager>().stop(pid))
            .await
    {
        warn!("the duplication teardown for PID {pid} did not finish: {e}");
        // A JoinError almost always means the closure never ran (the blocking
        // pool was gone), so the engine above is still pumping mirrors. `stop`
        // only takes the engine down and signals its threads, and is idempotent
        // — if a partial teardown already removed it this finds nothing — so
        // take it down here rather than leave a running engine behind the
        // endpoint release below. This is a worker thread, not the UI loop.
        duplications.stop(pid);
    }

    let outcome = if sibling_routed {
        // The assignment Windows persists is stored per executable, and a
        // sibling process of this program is still routed: releasing it here
        // would take that route's primary endpoint away while its mirrors kept
        // playing — the same trap `release_stale_routes` guards against. The
        // assignment stays, owned by the sibling's route, and this PID keeps
        // following it like every other session of the program.
        //
        // This PID's own entry goes with its route, though: the assignment it
        // described is the executable's, and the sibling's route carries its
        // own entry. Left standing, this one would outlive its engine and block
        // the sibling's own stop from ever releasing the assignment.
        let pinned = pins.device_of(pid);
        pins.forget(pid);
        info!(
            "stopped PID {pid}; its assignment stays because the same executable is still routed"
        );
        Ok(StopOutcome {
            released: false,
            pinned_device: pinned,
            sibling_held: true,
        })
    } else {
        // Release the *render* half only: the capture half is a feed's, not a
        // route's, and a program that receives another program's sound must keep
        // receiving it when its own device route stops.
        match audio::routing::release_process_default_devices_flow(
            vec![pid],
            audio::Role::All,
            false,
        )
        .await
        {
            // Exactly one answer for the one pid asked: an empty list would satisfy
            // `all()` vacuously and let a stop claim it handed the program back to the
            // system default for a step the audio service never performed.
            Ok(outcomes)
                if outcomes.len() == 1
                    && outcomes.iter().all(|(_, o)| *o == ReleaseOutcome::Released) =>
            {
                pins.forget(pid);
                info!("stopped PID {pid} and released its endpoint assignment");
                Ok(StopOutcome {
                    released: true,
                    pinned_device: None,
                    sibling_held: false,
                })
            }
            Ok(outcomes) if superseded_release(&outcomes) => {
                // A newer write claimed this program's slot while the stop was setting
                // itself up, so the assignment the stop was aimed at is gone and that
                // writer's endpoint is what the program plays to now. Handing it to the
                // default — the fallback below — would take *their* route away to undo a
                // stop that lost, so the slot is left alone.
                //
                // What is ours to correct is the book: the engine is already down and the
                // frontend has dropped the badge, so an entry still reading as a live
                // route is the dead end `mark_abandoned` exists for — the reset skips
                // every executable with a route, the sweep skips every live pid, and the
                // board offers nothing to stop. Downgraded, the assignment stays on the
                // book, stays reachable by the reset, and gets released for good when
                // that writer's own route stops or this app quits.
                let pinned = pins.device_of(pid);
                warn!(
                    "stopping PID {pid} was superseded by a newer write; the slot stays with it{}",
                    pinned
                        .as_deref()
                        .map(|device| format!(" (this run last recorded {device})"))
                        .unwrap_or_default()
                );
                pins.mark_abandoned(pid);
                Ok(StopOutcome {
                    released: false,
                    pinned_device: pinned,
                    sibling_held: false,
                })
            }
            Ok(_) => {
                warn!("PID {pid} still carries an endpoint assignment after the release attempt");
                Ok(pin_to_default_or_abandon(pid, &pins).await)
            }
            Err(e) => {
                // The policy object was unavailable, so nothing could be released;
                // fall back to the pre-2.1.1 behaviour rather than leaving the
                // program on the device it was routed to.
                warn!("releasing the endpoint assignment of PID {pid} failed: {e}");
                Ok(pin_to_default_or_abandon(pid, &pins).await)
            }
        }
    };
    // A feed is not a route's property. The teardown above took down the engine
    // that carried its tap, so the tap is put back on an engine of its own —
    // otherwise stopping a route would silently cut a wire the user never asked
    // to lose. A stop that left the executable's assignment alone (a sibling is
    // still routed) took no engine with it, and restarting one here would put a
    // gap in a route the user did not stop.
    if !sibling_routed {
        if let Some(exe) = &released_exe {
            resume_feed_taps(exe, &feeds, &carrier, &pins, &app).await;
        }
    }
    outcome
}

/// Point a program at the system default and admit that it stays pinned there.
///
/// Only used when the assignment could not be released, where the choice is
/// between "playing on the default but ignoring later device switches" and
/// "playing on a device the user did not ask for"; the first is closer to what
/// stopping a route promises.
async fn pin_to_default(pid: u32, device_id: &str, pins: &PinnedRoutes) -> StopOutcome {
    match audio::routing::set_process_default_device(device_id, pid, audio::Role::All).await {
        Ok(()) => {
            let exe_name = exe_name_of(pid);
            // Recorded as handed back, not as a route: nothing is routing this
            // program, and the reset in the settings page has to be able to
            // clear the assignment Windows would not release here.
            pins.mark_returned(pid, &exe_name, device_id);
            StopOutcome {
                released: false,
                pinned_device: Some(device_id.to_string()),
                sibling_held: false,
            }
        }
        Err(e) => {
            warn!("could not point PID {pid} at the default device: {e}");
            // Neither the release nor the fallback landed. The entry has to come
            // off `Route`: while it reads as a live route the settings page's
            // reset skips the whole executable, the stale sweep skips the pid,
            // and the board shows no route for the user to stop — leaving an app
            // restart as the only way back. It stays in the book, because the
            // assignment is still ours and quitting has to try again.
            pins.mark_abandoned(pid);
            StopOutcome {
                released: false,
                pinned_device: None,
                sibling_held: false,
            }
        }
    }
}

/// The stop's fallback when the assignment would not release: point the
/// program at the system default and admit the pin.
///
/// The default device is looked up here rather than before the release, and a
/// failed lookup downgrades the entry instead of aborting the stop: by this
/// line the engine is already down, and returning an error would strand a
/// `Route` entry no later path can reach — the reset skips live routes, the
/// sweep skips live pids, and the board shows no route to stop.
async fn pin_to_default_or_abandon(pid: u32, pins: &PinnedRoutes) -> StopOutcome {
    match tokio::task::spawn_blocking(audio::devices::get_default_render_device).await {
        Ok(Ok(default)) => pin_to_default(pid, &default.id, pins).await,
        _ => {
            warn!("could not look up the default device to fall back on for PID {pid}");
            pins.mark_abandoned(pid);
            StopOutcome {
                released: false,
                pinned_device: None,
                sibling_held: false,
            }
        }
    }
}
