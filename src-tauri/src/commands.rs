//! Tauri command handlers.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use log::{debug, info, warn};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::audio;
use crate::audio::duplication::{ActiveRoute, DuplicationManager};
use crate::audio::levels::{
    aligned_gains, audible_count, SourceLevel, SourceLevels, LEVEL_MAX_AGE,
};
use crate::audio::routing::{PinnedRoutes, ReleaseOutcome};
use crate::config::{
    AppSettings, DelayConfig, FeedCarrier, FeedCarrierConfig, FeedConfig, PrimaryVolumeConfig,
    RouteConfig, SourceVolumeConfig, VolumeConfig, SOURCE_VOLUME_MAX,
};
use crate::install::{StartupNotice, StartupNoticeState};

/// What a stop left behind.
#[derive(Debug, Serialize)]
pub struct StopOutcome {
    /// True when the program follows the system default again — the assignment
    /// this app wrote is gone, so a later change of the default device moves it.
    pub released: bool,
    /// Endpoint the program is still pinned to, when the release did not take.
    /// The UI warns about this instead of claiming the route is fully undone.
    /// Which of the two failures left it pinned is the `sibling_held` flag's
    /// business, not something the UI may infer from the presence of a device.
    pub pinned_device: Option<String>,
    /// True when `released` is false because a sibling process of the same
    /// executable still routes the program: the assignment is owned by that live
    /// route and will go back when the sibling stops, not stuck. The stop path
    /// also yields `released: false` when Windows refused to clear the pin (and
    /// the program was pointed at the default), and when a *newer* write claimed
    /// the program's slot before this stop's release reached it — there the slot
    /// was deliberately left to that newer writer, so neither the fallback write
    /// nor the `sibling_held` flag describes it. The UI must not infer which it
    /// got — reporting a refused release as a sibling route would drop the device
    /// name and hide a real failure.
    pub sibling_held: bool,
}

/// Whether a release walk answered that it never asked the service at all,
/// because a newer write claimed that program's slot first.
///
/// Worth pulling out because it is the one outcome a caller must *not* treat as a
/// release that merely failed to confirm: the fallback paths below exist to point
/// the program somewhere sensible when Windows would not let go, and writing the
/// default device over a slot that a newer route just took is not sensible — it is
/// the race this ordering exists to close, arriving by way of the rollback.
fn superseded_release(outcomes: &[(u32, ReleaseOutcome)]) -> bool {
    outcomes
        .iter()
        .any(|(_, outcome)| *outcome == ReleaseOutcome::Superseded)
}

/// What a sweep of left-over assignments found.
#[derive(Debug, Serialize)]
pub struct ResetOutcome {
    /// Programs whose assignment was released.
    pub released: usize,
    /// Executable names still carrying an assignment the service would not drop.
    pub still_pinned: Vec<String>,
    /// One entry per `still_pinned`, same order and length: the endpoint id
    /// Windows still holds for it, or `null` when the audio service would not
    /// answer for that process so no device can be named. A stop reports this as
    /// `pinned_device`; the reset owed the same "which device stays fixed" answer
    /// and did not have it.
    pub still_pinned_devices: Vec<Option<String>>,
}

/// What one run of the level alignment did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignOutcome {
    /// Programs whose level was set, as `(exe_name, percent)`.
    pub aligned: Vec<(String, u32)>,
    /// Programs that were routed but left exactly as they were, because nothing
    /// was playing in them to measure. Aligning against silence would be
    /// aligning against nothing.
    pub left_alone: Vec<String>,
    /// How many routed programs had a level to align with — a live reading that
    /// was not silence.
    ///
    /// Reported because an empty `aligned` has two different reasons behind it:
    /// nothing was playing, or only one program was, and one program cannot be
    /// aligned against itself. The caller has to be able to say which, and a
    /// program sitting in a quiet passage is not "playing" for that purpose —
    /// counting the live readings instead would tell a user who can hear sound
    /// that none of their programs made any.
    pub playing: usize,
}

/// One process's executable icon, decoded to RGBA for the frontend's canvas.
///
/// The frontend asks per process it lists; the backend caches per executable,
/// so the shell's extraction is paid once and every later ask — another
/// session of the same program, the next refresh — reads the cache. Returns
/// `None` when the process is gone or its file carries no icon: the frontend
/// keeps its letter tile and asks again — first on its own bounded retries,
/// then on the next refresh, since a miss can be the ask losing a race to a
/// dying pid rather than a file that truly has no icon.
#[tauri::command]
pub async fn get_process_icon(pid: u32) -> Result<Option<audio::process_meta::IconImage>, String> {
    debug!("cmd: get_process_icon pid={pid}");
    // pid 0 is the system-sounds session and not a process to open.
    if pid == 0 {
        return Ok(None);
    }
    tokio::task::spawn_blocking(move || audio::process_meta::icon_for_process(pid))
        .await
        .map_err(|e| e.to_string())
}

/// List all active render (playback) devices.
///
/// Async so the walk runs on a blocking thread instead of the WebView2 main
/// thread, which a sync command would hold for the whole enumeration.
#[tauri::command]
pub async fn list_devices() -> Result<Vec<audio::AudioDevice>, String> {
    info!("cmd: list_devices");
    tokio::task::spawn_blocking(audio::devices::enumerate_render_devices)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// List all active audio sessions (processes with audio).
#[tauri::command]
pub async fn list_sessions() -> Result<Vec<audio::AudioSession>, String> {
    info!("cmd: list_sessions");
    tokio::task::spawn_blocking(audio::sessions::enumerate_sessions)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// The executable name of `pid`, or an empty string when it cannot be read.
///
/// The name is bookkeeping for the assignments the audio service persists per
/// executable, so failing to read it must not fail the route. It must not pass
/// unnoticed either: a blank name is what later leaves a sweep unable to say
/// which program an assignment belongs to, and looks like the assignment
/// belongs to no program at all.
fn exe_name_of(pid: u32) -> String {
    match audio::sessions::get_process_exe_name(pid) {
        Some(name) => name,
        None => {
            warn!("PID {pid} has no readable executable name; its assignment is recorded unnamed");
            String::new()
        }
    }
}

/// Get the current system default render device.
#[tauri::command]
pub async fn get_default_device() -> Result<audio::AudioDevice, String> {
    info!("cmd: get_default_device");
    tokio::task::spawn_blocking(audio::devices::get_default_render_device)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Refuse a command that names no program.
///
/// Every program-side key this app persists is an executable name, and a blank
/// one is a record no session can ever match: it would sit on the settings page
/// as a remembered rule nobody owns, be read by no engine, and — for a feed —
/// stand behind an endpoint pin no removal can find again. The write path already
/// refuses a process whose name it cannot read; this stops the same nonsense
/// arriving as an argument instead of being inferred from one.
fn require_exe_name(what: &str, exe_name: &str) -> Result<(), String> {
    if exe_name.trim().is_empty() {
        return Err(format!("{what} needs the program it applies to"));
    }
    Ok(())
}

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

/// The carrier endpoint a feed tap writes into, when `exe` sends at least one
/// feed and both halves of the carrier are configured.
///
/// `None` covers the two quiet cases on purpose: a programme that sends nothing
/// has no tap, and a feed without a carrier is recorded but cannot move sound.
fn feed_tap_for(exe: &str, feeds: &FeedConfig, carrier: &FeedCarrierConfig) -> Option<String> {
    let pair = carrier.get();
    let render = pair.render?;
    pair.capture.as_ref()?;
    feeds
        .all()
        .iter()
        .any(|(source, _)| source.eq_ignore_ascii_case(exe))
        .then_some(render)
}

/// The route `pid` is serving right now, as the engine knows it.
///
/// The engine is authoritative while it runs; without one, a single-device
/// route lives only on the book (`PinnedRoutes`), because Windows plays that
/// endpoint itself and no engine exists for it. `None` means the programme is
/// not routed at all — the normal state of a programme that only feeds.
fn route_targets_of(
    duplications: &DuplicationManager,
    pins: &PinnedRoutes,
    pid: u32,
) -> Option<(String, Vec<String>)> {
    if let Some(targets) = duplications.device_targets_of(pid) {
        return Some(targets);
    }
    pins.device_of(pid).map(|device| (device, Vec::new()))
}

/// Bring `pid`'s engine in line with the feed memory: one tap while the
/// programme sends a feed through a configured carrier, none otherwise.
///
/// A tap is added or removed by restarting the engine with the same route,
/// because an engine's mirror list is fixed for its lifetime. The route's own
/// devices come back exactly as they were (`device_targets_of`), so restarting
/// for a feed never changes what the user's devices play.
async fn sync_feed_tap(
    pid: u32,
    exe: &str,
    feeds: &FeedConfig,
    carrier: &FeedCarrierConfig,
    pins: &PinnedRoutes,
    app: &AppHandle,
) -> Result<u64, String> {
    let tap = feed_tap_for(exe, feeds, carrier);
    let duplications = app.state::<DuplicationManager>();
    let targets = route_targets_of(&duplications, pins, pid);
    // Nothing to do: an engine is already serving this route with exactly this
    // tap. Restarting it would put a gap in the programme's sound for a change
    // that is not one — adding a second feed from the same source, or taking one
    // of two away, leaves the tap where it is.
    if targets.is_some() && duplications.feed_tap_of(pid) == tap {
        return Ok(0);
    }
    drop(duplications);
    let exe = exe.to_string();
    let app = app.clone();
    tokio::task::spawn_blocking(move || {
        let duplications = app.state::<DuplicationManager>();
        match targets {
            Some((primary, mirrors)) => {
                if mirrors.is_empty() && tap.is_none() {
                    // An engine with no copies and no tap has nothing to do: a
                    // single-device route is Windows' own endpoint.
                    duplications.stop(pid);
                    return Ok(0);
                }
                duplications
                    .start(pid, &exe, &primary, mirrors, tap, &app)
                    .map_err(|e| e.to_string())
            }
            None => match tap {
                Some(tap) => {
                    // Unrouted, but feeding: the engine's primary is only the
                    // delay baseline, and the engine never writes it — the
                    // programme keeps playing where Windows has it.
                    let primary = audio::devices::get_default_render_device()
                        .map(|device| device.id)
                        .unwrap_or_default();
                    duplications
                        .start(pid, &exe, &primary, Vec::new(), Some(tap), &app)
                        .map_err(|e| e.to_string())
                }
                None => {
                    duplications.stop(pid);
                    Ok(0)
                }
            },
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Put the feed taps of `exe` back on after its engine was taken down with a
/// route.
///
/// A feed now outlives the device route it was added alongside: the tap is the
/// wire into the carrier, and stopping a route must not cut it. The rules
/// themselves are the feed memory's; the pins say which processes are sending.
async fn resume_feed_taps(
    exe: &str,
    feeds: &FeedConfig,
    carrier: &FeedCarrierConfig,
    pins: &PinnedRoutes,
    app: &AppHandle,
) {
    if feed_tap_for(exe, feeds, carrier).is_none() {
        return;
    }
    for (feed_pid, source_exe) in pins.feed_source_pins() {
        if !source_exe.eq_ignore_ascii_case(exe) {
            continue;
        }
        // `feed_source_pins` hands out only the pins that still speak for a live
        // process, so nothing below can start an engine through a pid the kernel
        // has since handed on.
        match sync_feed_tap(feed_pid, &source_exe, feeds, carrier, pins, app).await {
            Ok(_) => info!("feed of PID {feed_pid} is back on its carrier"),
            Err(e) => warn!("could not put the feed of PID {feed_pid} back on: {e}"),
        }
    }
}

/// Forget what this app remembers and what it has been tuned to: every
/// remembered route and feed rule, every device delay and share, every program
/// level. The "start clean" half of the tour's inherit question, offered to a
/// machine walking into this version from an older one.
///
/// Deliberately not here: the per-app endpoint assignments (the tour's own
/// reset offer, which also reaches what the user set by hand in the volume
/// mixer and is therefore always its own button), the primary volumes (a
/// program's session volume is the program's business, not this app's memory
/// of it), and the shell settings (close-to-tray and the startup entry are
/// habits, not learned state).
#[tauri::command]
pub fn forget_previous_settings(
    routes: State<'_, RouteConfig>,
    feeds: State<'_, FeedConfig>,
    delays: State<'_, Arc<DelayConfig>>,
    volumes: State<'_, Arc<VolumeConfig>>,
    sources: State<'_, Arc<SourceVolumeConfig>>,
) -> Result<(), String> {
    info!("cmd: forget_previous_settings");
    routes.clear()?;
    feeds.clear()?;
    delays.clear()?;
    volumes.clear()?;
    sources.clear()
}

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

/// Live duplication engines and their ordered device lists.
#[tauri::command]
pub fn get_active_duplications(duplications: State<'_, DuplicationManager>) -> Vec<ActiveRoute> {
    duplications.active_routes()
}

/// Set a device's delay compensation (milliseconds, signed) and push it to any
/// live engine using that device.
///
/// Positive holds the device back; negative marks it as the earliest device in
/// the group, which lifts the other mirrors instead. A magnitude beyond the
/// hard bound (`config::DELAY_MAX_MS`, the rail the engine's ring buffers are
/// sized to) is rejected.
#[tauri::command]
pub fn set_device_delay(
    device_id: String,
    delay_ms: i32,
    delays: State<'_, Arc<DelayConfig>>,
    duplications: State<'_, DuplicationManager>,
) -> Result<(), String> {
    info!("cmd: set_device_delay device={device_id} delay={delay_ms}ms");
    // The key is validated here even though a delay never reaches a COM call: it
    // is the only handle to that device's tuning, and a blank or absurd key is an
    // entry no enumeration can ever name, list back or clear. Same bound as the
    // write path and the carrier picker, so the three of them cannot disagree
    // about what a device id is.
    audio::routing::validate_device_id(&device_id).map_err(|e| e.to_string())?;
    delays.set(&device_id, delay_ms)?;
    duplications.update_delay(&device_id, delay_ms);
    Ok(())
}

/// All configured device delays as `(device_id, delay_ms)` pairs.
#[tauri::command]
pub fn get_device_delays(delays: State<'_, Arc<DelayConfig>>) -> Vec<(String, i32)> {
    delays.all()
}

/// Play the delay-wizard's test tone on one device: `reps` short bursts with
/// pauses between them, each burst bracketed by a `calibration-tone` event
/// pair (`start` when its first frame is written, `end` when its last one is).
///
/// The wizard's round-robin drives one burst per call (`reps = 1`), drawing a
/// fresh random `lead_ms` each time so the pace stays unpredictable across the
/// whole session, and a short `tail_ms` between calls; the defaults describe a
/// standalone single-device sequence. Values are clamped inside the player.
///
/// `run` names the wizard's run, and it is what lets a start that arrives *after*
/// the user's cancel be refused instead of played: the cancel lands on the IPC
/// thread while this command's body is still queued, so without a run to compare,
/// the start would clear the cancel it had just caused and sound into a dialog
/// that is gone. Passing it is precise — only that run is refused. A caller that
/// names no run still gets the race closed, by the coarser rule in
/// [`audio::calibration::CalibrationState::begin`]; see
/// [`audio::calibration::NO_RUN_TOKEN`].
///
/// Resolves when the whole sequence has played, so the frontend treats the
/// command's promise as "this burst is done" and the events as the timeline
/// itself. Only one run exists at a time; `calibration_cancel` ends the
/// current one within a backstop interval.
#[tauri::command]
pub async fn calibration_start(
    device_id: String,
    reps: Option<usize>,
    lead_ms: Option<usize>,
    tail_ms: Option<usize>,
    run: Option<u64>,
    app: AppHandle,
    state: State<'_, audio::calibration::CalibrationState>,
) -> Result<(), String> {
    info!(
        "cmd: calibration_start device={device_id} reps={reps:?} lead={lead_ms:?} tail={tail_ms:?} run={run:?}"
    );
    audio::routing::validate_device_id(&device_id).map_err(|e| e.to_string())?;
    let run = run.unwrap_or(audio::calibration::NO_RUN_TOKEN);
    if let Err(refusal) = state.begin(run) {
        if refusal == audio::calibration::Refusal::Cancelled {
            // The wizard is already gone by definition, so this line is the only
            // trace the burst was stopped rather than never asked for.
            info!(
                "calibration start for run {run} was cancelled before it was admitted; refusing it"
            );
        }
        return Err(refusal.message().to_string());
    }
    let (guard, cancel) = state.worker_tokens();
    tokio::task::spawn_blocking(move || {
        // The guard hands the busy flag back on every exit, panics included.
        let _guard = guard;
        audio::calibration::play_test_tone(
            &device_id,
            reps.unwrap_or(audio::calibration::TONE_REPS_DEFAULT),
            lead_ms.unwrap_or(audio::calibration::LEAD_MS_DEFAULT),
            tail_ms.unwrap_or(audio::calibration::TAIL_MS_DEFAULT),
            &app,
            &cancel,
        )
    })
    .await
    .map_err(|e| format!("calibration worker failed: {e}"))?
    .map_err(|e| e.to_string())
}

/// Ask the running calibration to stop. The start command resolves with an
/// error shortly after; the frontend that called cancel simply ignores it.
///
/// `run` names the run the caller means, which is what lets a start still in
/// flight for *that* run be refused when it lands. The burst that is sounding is
/// stopped whichever run the caller named: a user who said stop is heard, and the
/// token only decides what may still begin.
#[tauri::command]
pub fn calibration_cancel(
    run: Option<u64>,
    state: State<'_, audio::calibration::CalibrationState>,
) {
    state.cancel(run.unwrap_or(audio::calibration::NO_RUN_TOKEN));
    // The generation is read after the cancel it just took, because that number is
    // the only thing this side can say about the start/cancel race: it is what tells
    // a refused start from a burst nobody asked to stop, in a log line the wizard's
    // own dialog has already walked away from.
    info!(
        "cmd: calibration_cancel run={run:?} generation={}",
        state.generation()
    );
}

/// Set a device's volume (percent, 0–100) and push it to any live engine using
/// that device as a mirror.
///
/// The value is the device's share of the loudest copy in its group: the
/// engine scales every mirror by `own / max`, so 100 leaves that device at the
/// level the app produced and smaller values attenuate it. The primary device
/// takes no share — its loudness is the program's session volume (see
/// [`set_primary_volume`]), and a value stored for the device applies whenever
/// it plays as a copy.
#[tauri::command]
pub fn set_device_volume(
    device_id: String,
    percent: u32,
    volumes: State<'_, Arc<VolumeConfig>>,
    duplications: State<'_, DuplicationManager>,
) -> Result<(), String> {
    info!("cmd: set_device_volume device={device_id} volume={percent}%");
    if percent > 100 {
        return Err("volume out of range 0-100".to_string());
    }
    // Same reason the delay key is checked: a share is stored under the device id
    // and read back by it for as long as the file lives.
    audio::routing::validate_device_id(&device_id).map_err(|e| e.to_string())?;
    volumes.set(&device_id, percent)?;
    duplications.update_volume(&device_id, percent);
    Ok(())
}

/// All configured device volumes as `(device_id, percent)` pairs.
#[tauri::command]
pub fn get_device_volumes(volumes: State<'_, Arc<VolumeConfig>>) -> Vec<(String, u32)> {
    volumes.all()
}

/// Set one program's own level (0–[`config::SOURCE_VOLUME_MAX`], where 100 is
/// that program's audio untouched) and push it to the engines already running
/// for it. Rejects out-of-range values rather than clamping, so the two sides
/// cannot end up disagreeing about what was stored.
#[tauri::command]
pub fn set_source_volume(
    exe_name: String,
    percent: u32,
    sources: State<'_, Arc<SourceVolumeConfig>>,
    duplications: State<'_, DuplicationManager>,
) -> Result<(), String> {
    info!("cmd: set_source_volume exe={exe_name} level={percent}%");
    // The key this level is stored and read under is the executable name; a blank
    // one is a level no engine will ever ask for and the settings page will still
    // list.
    require_exe_name("a program level", &exe_name)?;
    sources.set(&exe_name, percent)?;
    duplications.update_source_volume(&exe_name, percent);
    Ok(())
}

/// Every stored per-program level as `(exe_name, percent)` pairs.
#[tauri::command]
pub fn get_source_volumes(sources: State<'_, Arc<SourceVolumeConfig>>) -> Vec<(String, u32)> {
    sources.all()
}

/// Set a routed program's primary volume — its **session volume**, the value
/// the Windows volume mixer shows for it — and push it to the engines already
/// running for it.
///
/// This is the one lever that reaches the primary device's loudness: Windows
/// plays that device itself, and the loopback tap sits behind the session
/// volume, so attenuating the session attenuates the primary path. The engines
/// divide every mirror's gain by the same factor, so the copies play on
/// exactly as before and only the primary path moves. The value is floored at
/// [`config::PRIMARY_VOLUME_MIN_PERCENT`] because at 0 the capture is true
/// silence and no gain could restore the copies. Stopping the route hands the
/// program's previous loudness back.
///
/// Async, unlike the other volume commands: writing the value onto the live
/// sessions is a full device and session enumeration per engine, and a sync
/// command would run that on the WebView2 main thread — freezing the window for
/// as long as AudioSrv takes, which on a reconnecting Bluetooth endpoint is
/// seconds.
///
/// Being async costs the main thread's serialisation, so two clicks can run
/// here at once. Both halves of the write therefore take the *same* number: the
/// one the config settled on, read back inside the lock's critical section —
/// never the caller's own `percent`, which a later click may already have
/// replaced.
#[tauri::command]
pub async fn set_primary_volume(
    exe_name: String,
    percent: u32,
    app: AppHandle,
) -> Result<(), String> {
    info!("cmd: set_primary_volume exe={exe_name} volume={percent}%");
    require_exe_name("a program volume", &exe_name)?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let primaries = app.state::<Arc<PrimaryVolumeConfig>>();
        primaries.set(&exe_name, percent)?;
        // Read back, so overlapping calls converge on the last committed value
        // instead of each pushing its own: the file and the live sessions then
        // cannot land on different numbers, whichever order the two writes
        // reached the lock in. A click that a later one superseded restates the
        // settled value and changes nothing.
        let settled = primaries.get(&exe_name);
        app.state::<DuplicationManager>()
            .update_primary_volume(&exe_name, settled);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Every stored primary volume as `(exe_name, percent)` pairs.
#[tauri::command]
pub fn get_primary_volumes(primaries: State<'_, Arc<PrimaryVolumeConfig>>) -> Vec<(String, u32)> {
    primaries.all()
}

/// Bring every routed program that is playing up to the level of the loudest
/// one, in one action.
///
/// The group is whatever this app is duplicating right now rather than a list
/// handed over by the frontend: that way it cannot name a program that is not
/// routed, and a program holding several sessions cannot arrive twice under two
/// PIDs. A program with nothing playing is left exactly as it was — aligning
/// against silence would be aligning against nothing — and so is one the
/// measurement could not read.
///
/// This overwrites levels the user set by hand, which is what "align them"
/// means; the values it writes are ordinary stored levels afterwards, so they
/// can be edited from the same place as any other.
#[tauri::command]
pub fn align_source_levels(
    sources: State<'_, Arc<SourceVolumeConfig>>,
    levels: State<'_, Arc<SourceLevels>>,
    duplications: State<'_, DuplicationManager>,
) -> Result<AlignOutcome, String> {
    let routed = duplications.routed_exe_names();
    let playing: Vec<(String, SourceLevel)> = levels
        .fresh_all(LEVEL_MAX_AGE)
        .into_iter()
        .filter(|(exe_name, _)| routed.contains(exe_name))
        .collect();

    let gains = aligned_gains(&playing);
    // "Playing" means a program a listener would call playing — a live
    // reading above silence — not a program that ended up with a gain: the
    // gains only exist once two audible programs are aligned against each
    // other, and counting them would tell a user who can hear exactly one
    // program that nothing was sounding at all.
    let audible = audible_count(&playing);
    let mut applied = Vec::new();
    for (exe_name, gain) in gains {
        let percent = (gain * 100.0).round().clamp(0.0, SOURCE_VOLUME_MAX as f32) as u32;
        sources.set(&exe_name, percent)?;
        duplications.update_source_volume(&exe_name, percent);
        info!("aligned {exe_name} to {percent}%");
        applied.push((exe_name, percent));
    }

    let changed: HashSet<&str> = applied.iter().map(|(name, _)| name.as_str()).collect();
    let left_alone = routed
        .into_iter()
        .filter(|name| !changed.contains(name.as_str()))
        .collect();
    Ok(AlignOutcome {
        aligned: applied,
        left_alone,
        playing: audible,
    })
}

/// Get all remembered routes as `(exe_name, device_ids)` pairs.
#[tauri::command]
pub fn get_remembered_routes(
    config: State<'_, RouteConfig>,
) -> Vec<(String, crate::config::DeviceList)> {
    config.get_all_routes()
}

/// Clear a remembered route.
#[tauri::command]
pub fn clear_route(exe_name: String, config: State<'_, RouteConfig>) -> Result<(), String> {
    config.remove_route(&exe_name)
}

// ---------------------------------------------------------------- shell

/// Whether closing the window hides it to the tray instead of quitting.
#[tauri::command]
pub fn get_close_to_tray(settings: State<'_, AppSettings>) -> bool {
    settings.close_to_tray()
}

/// Set the close-to-tray preference.
#[tauri::command]
pub fn set_close_to_tray(enabled: bool, settings: State<'_, AppSettings>) -> Result<(), String> {
    info!("cmd: set_close_to_tray enabled={enabled}");
    settings.set_close_to_tray(enabled)
}

/// Whether the app is registered to start at logon.
#[tauri::command]
pub fn get_autostart() -> Result<bool, String> {
    crate::autostart::is_enabled()
}

/// Register or unregister the logon startup entry.
#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<(), String> {
    info!("cmd: set_autostart enabled={enabled}");
    crate::autostart::set_enabled(enabled)
}

/// True when Windows launched this instance at logon.
///
/// The startup entry carries `--hidden` so a boot does not put a window in front
/// of the user; the frontend asks this before it reveals itself.
#[tauri::command]
pub fn is_silent_launch() -> bool {
    crate::autostart::is_silent_launch()
}

/// Push the tray menu's labels in the frontend's language, and the startup
/// item's check mark — the registry is the truth for that one, and the tray
/// shows what the settings page would.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn set_tray_labels(
    show: String,
    open_settings: String,
    autostart: String,
    autostart_checked: bool,
    stop_all: String,
    quit: String,
    app: AppHandle,
) -> Result<(), String> {
    crate::tray::set_labels(
        &app,
        &show,
        &open_settings,
        &autostart,
        autostart_checked,
        &stop_all,
        &quit,
    )
}

// ---------------------------------------------------------------- launch notice

/// What the window should say about this install, if anything.
///
/// Either it is the first launch of a fresh install, or an earlier version ran
/// here and may have left per-app endpoint assignments behind — the leftovers
/// 2.1.1 fixes, which nothing in the app can tell apart from assignments the user
/// made by hand.
#[tauri::command]
pub fn get_startup_notice(state: State<'_, StartupNoticeState>) -> Option<StartupNotice> {
    state.notice()
}

/// Record that this version has run, so the notice is not shown again.
#[tauri::command]
pub fn ack_startup_notice(state: State<'_, StartupNoticeState>) -> Result<(), String> {
    info!("cmd: ack_startup_notice");
    state.ack()
}

// ------------------------------------------------------------------- feeds

/// What one feed change actually did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedOutcome {
    /// True when the wire is in place and sound can move.
    pub delivered: bool,
    /// Why it could not be delivered, when it could not: `no_carrier` — no
    /// loopback pair is configured yet, so the rule is recorded and waits.
    pub reason: Option<FeedBlockReason>,
}

/// Why a recorded feed is not moving sound.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedBlockReason {
    NoCarrier,
}

/// Recording endpoints, for the carrier picker in settings.
#[tauri::command]
pub async fn list_capture_devices() -> Result<Vec<audio::AudioDevice>, String> {
    info!("cmd: list_capture_devices");
    tokio::task::spawn_blocking(audio::devices::enumerate_capture_devices)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// The loopback endpoint pair that carries feeds.
#[tauri::command]
pub fn get_feed_carrier(carrier: State<'_, FeedCarrierConfig>) -> FeedCarrier {
    carrier.get()
}

/// Replace the carrier pair. Both halves may be null ("not configured").
#[tauri::command]
pub fn set_feed_carrier(
    render: Option<String>,
    capture: Option<String>,
    carrier: State<'_, FeedCarrierConfig>,
) -> Result<(), String> {
    info!("cmd: set_feed_carrier render={render:?} capture={capture:?}");
    if let Some(id) = render.as_deref() {
        audio::routing::validate_device_id(id).map_err(|e| e.to_string())?;
    }
    if let Some(id) = capture.as_deref() {
        audio::routing::validate_device_id(id).map_err(|e| e.to_string())?;
    }
    carrier.set(render, capture)
}

/// Every remembered feed rule as `(source_exe, target_exe)` pairs.
#[tauri::command]
pub fn list_feeds(feeds: State<'_, FeedConfig>) -> Vec<(String, String)> {
    feeds.all()
}

/// Send one program's audio into another program's input.
///
/// A feed is **additional**, not a move: the source keeps playing wherever it
/// already plays — its device route, or the system default — and the engine
/// gets one extra destination that is not a device (the *tap*, see
/// `MirrorChannel::feed_tap`), writing the same captured audio into the
/// carrier's playback side. The target's capture endpoint is pinned to the
/// carrier's recording side, which is what makes it record the source. Both
/// halves are written down so they can be handed back, and the rule goes into
/// the feed memory so it survives a restart.
///
/// The one thing this must never do is take the source's own output away: the
/// per-app endpoint is a single slot per data flow, and pointing it at the
/// carrier is exactly what used to silence the programme on the device it was
/// playing on. The tap exists so that choice never has to be made.
// Tauri commands carry their State params in the signature, so the argument
// count is fixed by the framework.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn set_feed_target(
    source_pid: u32,
    source_exe: String,
    target_pid: u32,
    target_exe: String,
    feeds: State<'_, FeedConfig>,
    carrier: State<'_, FeedCarrierConfig>,
    pins: State<'_, PinnedRoutes>,
    app: AppHandle,
) -> Result<FeedOutcome, String> {
    info!("cmd: set_feed_target {source_exe} ({source_pid}) -> {target_exe} ({target_pid})");
    if source_pid == 0 || target_pid == 0 || source_pid == target_pid {
        return Err("a feed needs two distinct processes".to_string());
    }
    if source_exe.eq_ignore_ascii_case(&target_exe) {
        return Err("a program cannot be fed into itself".to_string());
    }
    // Both halves of the rule are keyed by executable name, and the pins that hold
    // the two endpoints are looked up by that name on the way out: a blank one
    // would be a feed nothing can ever remove.
    require_exe_name("the sending program of a feed", &source_exe)?;
    require_exe_name("the receiving program of a feed", &target_exe)?;
    // The rule is recorded first: an undeliverable feed is still the user's
    // decision, and the board shows it with the reason it is quiet. Recording
    // is cheap and idempotent.
    feeds.add(&source_exe, &target_exe)?;

    let pair = carrier.get();
    let (Some(_), Some(capture)) = (pair.render.clone(), pair.capture.clone()) else {
        return Ok(FeedOutcome {
            delivered: false,
            reason: Some(FeedBlockReason::NoCarrier),
        });
    };

    // The capture half is the target's own endpoint, and the only one a feed
    // ever writes onto a program that is not its source.
    if let Err(e) =
        audio::routing::set_process_default_capture_device(&capture, target_pid, audio::Role::All)
            .await
    {
        // The frontend rolls its optimistic write back on an error, so the
        // rule this call recorded must go too, or the next launch would
        // resurrect a feed the UI does not show. A removal that itself fails
        // has to be said out loud: the resurrecting rule is the one failure
        // nothing else here reports.
        if let Err(recover) = feeds.remove(&source_exe, &target_exe) {
            warn!("the feed rule of {source_exe} -> {target_exe} stayed on file: {recover}");
        }
        return Err(e.to_string());
    }
    pins.mark_feed_capture(target_pid, &target_exe);
    // The sending half is the tap, and the pin records that this programme is a
    // feed source — that is what a removal, a restart of the route, and a sweep
    // read.
    pins.mark_feed(source_pid, &source_exe);
    match sync_feed_tap(source_pid, &source_exe, &feeds, &carrier, &pins, &app).await {
        Ok(_) => Ok(FeedOutcome {
            delivered: true,
            reason: None,
        }),
        Err(e) => {
            // Nothing moves, so nothing may be left behind: the target's mic
            // must not stay pointed at a carrier that receives no audio, the
            // rule must not come back on the next launch, and the pin must not
            // outlive either. Another rule may still need the same capture
            // endpoint, so the release is guarded by what remains.
            let target_still_needed = feeds.all().iter().any(|(src, tgt)| {
                tgt.eq_ignore_ascii_case(&target_exe) && !src.eq_ignore_ascii_case(&source_exe)
            });
            if !target_still_needed && pins.feed_capture_of(target_pid).is_some() {
                let _ = audio::routing::release_process_default_devices_flow(
                    vec![target_pid],
                    audio::Role::All,
                    true,
                )
                .await;
                pins.forget_feed_capture(target_pid);
            }
            pins.forget_feed_source(source_pid);
            if let Err(recover) = feeds.remove(&source_exe, &target_exe) {
                warn!("the feed rule of {source_exe} -> {target_exe} stayed on file: {recover}");
            }
            // The engine restart that failed may have taken the route's own
            // engine down with it: put it back without the tap so the devices
            // keep playing even though the feed did not land.
            if let Err(retry) =
                sync_feed_tap(source_pid, &source_exe, &feeds, &carrier, &pins, &app).await
            {
                warn!(
                    "could not put the route of PID {source_pid} back after a failed feed: {retry}"
                );
            }
            Err(e)
        }
    }
}

/// Take one feed rule back: drop it from the memory, take its tap off the
/// source's engine and release the target's capture endpoint.
///
/// A source that is also routed keeps playing on its devices throughout: the
/// tap is the only thing that goes, and the engine is restarted with the same
/// route minus that one destination.
///
/// Returns the programs that stay fixed to the carrier because Windows refused
/// to hand their endpoint back. The rule and the wire are gone either way — the
/// user asked for that, and the memory must not resurrect a feed they removed —
/// but a removal that quietly half-worked is invisible unless it is said.
#[tauri::command]
pub async fn remove_feed_target(
    source_pid: u32,
    target_pid: u32,
    feeds: State<'_, FeedConfig>,
    carrier: State<'_, FeedCarrierConfig>,
    pins: State<'_, PinnedRoutes>,
    app: AppHandle,
) -> Result<Vec<String>, String> {
    info!("cmd: remove_feed_target {source_pid} -> {target_pid}");
    // The same bound `set_feed_target` imposes on its way in: a feed has two real
    // processes or it is not a feed, and PID 0 (the system-sounds session) is one
    // the release walk below will not answer for.
    if source_pid == 0 || target_pid == 0 {
        return Err("a feed needs two real processes".to_string());
    }
    // The executable names decide which memory rule this is. The pins record
    // them for delivered feeds; a feed that was never delivered — recorded
    // with no carrier, or while its source was routed — has no pin to ask, so
    // the live process is asked directly. Without that fallback the rule
    // would stay in the memory while the board dropped it, and the next
    // launch would put it back.
    let source_exe = pins
        .feed_source_exe_of(source_pid)
        .or_else(|| audio::sessions::get_process_exe_name(source_pid))
        .unwrap_or_default();
    let target_exe = pins
        .feed_capture_exe_of(target_pid)
        .or_else(|| audio::sessions::get_process_exe_name(target_pid))
        .unwrap_or_default();
    if source_exe.is_empty() || target_exe.is_empty() {
        // Neither the pin nor the process can say which program this wire
        // belonged to, so the rule cannot be found and no endpoint can be
        // named: the memory would go on resurrecting a feed the board has
        // already dropped. Answering `Ok` here would report a removal that
        // did not happen — and this command's answer is exactly the channel
        // that carries "what is still stuck" to the user.
        return Err(format!(
            "the program behind this feed (PID {source_pid} in, PID {target_pid} out) is gone, \
             so its rule cannot be found to be forgotten — clear the remembered feed instead"
        ));
    }
    feeds.remove(&source_exe, &target_exe)?;
    // What is still on the books decides what this run may let go: a rule
    // from the same source or into the same target shares the endpoint pin,
    // and releasing it here would silence the feed that remains.
    let remaining = feeds.all();
    let source_still_needed = remaining
        .iter()
        .any(|(src, _)| src.eq_ignore_ascii_case(&source_exe));
    let target_still_needed = remaining
        .iter()
        .any(|(_, tgt)| tgt.eq_ignore_ascii_case(&target_exe));
    // The sending half is a tap inside the source's engine, not an endpoint
    // assignment, so it comes off by restarting that engine without it. While
    // another rule from the same source stands, the tap is exactly what has to
    // stay — restarting for it would only interrupt the audio.
    let mut stuck = Vec::new();
    if !source_still_needed && pins.feed_source_of(source_pid).is_some() {
        pins.forget_feed_source(source_pid);
        if let Err(e) = sync_feed_tap(source_pid, &source_exe, &feeds, &carrier, &pins, &app).await
        {
            warn!("could not take the feed tap of {source_exe} off: {e}");
        }
    }
    // The receiving half is the target's own capture endpoint and does belong to
    // the feed: a target with no capture pin of ours is left alone, and one that
    // Windows will not hand back is named.
    //
    // A pin comes off the book only when Windows accepted the clear. Forgetting
    // it on a refusal leaves that assignment with nothing on our side pointing
    // at it — the board has already dropped the wire, so no later command comes
    // back for it, and the program is left on the carrier with nothing but the
    // settings reset to explain why. So the pin stays, and the name goes into
    // the log line the frontend writes.
    if pins.feed_capture_of(target_pid).is_some() && !target_still_needed {
        if released_cleanly(
            audio::routing::release_process_default_devices_flow(
                vec![target_pid],
                audio::Role::All,
                true,
            )
            .await,
            "feed target",
        ) {
            pins.forget_feed_capture(target_pid);
        } else if !target_exe.is_empty() {
            stuck.push(target_exe);
        }
    }
    Ok(stuck)
}

/// Whether a release attempt came back clean for every endpoint it was asked
/// about, naming in the log the half that failed.
///
/// An answer of *nothing* is not a clean release: the walk skips a process it
/// will not speak for, and a caller that read an empty list as success would
/// forget its pin while the program stayed fixed to the endpoint — with the board
/// already moved on, nothing later would come back for it.
fn released_cleanly(
    release: Result<Vec<(u32, ReleaseOutcome)>, audio::AudioError>,
    which: &str,
) -> bool {
    match release {
        Ok(outcomes) => {
            if outcomes.is_empty() {
                warn!("the {which} endpoint release answered nothing for the process it was asked about");
                return false;
            }
            let stuck: Vec<String> = outcomes
                .iter()
                .filter(|(_, outcome)| *outcome != ReleaseOutcome::Released)
                .map(|(_, outcome)| match outcome {
                    ReleaseOutcome::StillPinned(device) => format!("still fixed to {device}"),
                    // Answered `false`, which is the whole requirement here: the pin
                    // stays on the book and the name goes into what the user is told,
                    // because the endpoint was not handed back by this run.
                    ReleaseOutcome::Superseded => {
                        "a newer write took the slot before this release".to_string()
                    }
                    _ => "not confirmed clear".to_string(),
                })
                .collect();
            if stuck.is_empty() {
                return true;
            }
            warn!(
                "the {which} endpoint was not handed back: {}",
                stuck.join(", ")
            );
            false
        }
        Err(e) => {
            warn!("could not ask for the {which} endpoint to be released: {e}");
            false
        }
    }
}

// ------------------------------------------------- carrier download pages

/// The download pages the carrier hint may point at. The mapping lives on this
/// side on purpose: the frontend names a driver key, never a URL, so nothing
/// user-controlled ever reaches the shell.
const CARRIER_PAGES: &[(&str, &str)] = &[
    ("vb-cable", "https://vb-audio.com/Cable/"),
    ("voicemeeter", "https://vb-audio.com/Voicemeeter/"),
];

/// Open a known loopback driver's download page in the user's browser.
#[tauri::command]
pub fn open_carrier_download(key: &str) -> Result<(), String> {
    info!("cmd: open_carrier_download {key}");
    let Some((_, url)) = CARRIER_PAGES.iter().find(|(name, _)| *name == key) else {
        return Err(format!("unknown carrier page key: {key}"));
    };
    open_in_browser(url)
}

/// The reference pages the About section points at. The same bargain as the
/// driver pages: the frontend names a key, never a URL, so nothing
/// user-controlled reaches the shell. The tour is gone once acknowledged and
/// there is no other documentation inside the window, so this is where a user
/// stuck on 未接通 can be sent.
const HELP_PAGES: &[(&str, &str)] = &[
    (
        "readme",
        "https://github.com/Eververdants/AppAudioRouter#readme",
    ),
    (
        "readme-zh",
        "https://github.com/Eververdants/AppAudioRouter/blob/main/README.zh-CN.md",
    ),
];

/// Open a reference page in the user's browser.
#[tauri::command]
pub fn open_help_page(key: &str) -> Result<(), String> {
    info!("cmd: open_help_page {key}");
    let Some((_, url)) = HELP_PAGES.iter().find(|(name, _)| *name == key) else {
        return Err(format!("unknown help page key: {key}"));
    };
    open_in_browser(url)
}

/// Hand a URL to the shell's "open" verb; the browser association decides
/// where it lands, and this process never sees the browser.
fn open_in_browser(url: &str) -> Result<(), String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    // SAFETY: the strings outlive the call, the verb is the literal "open" and
    // the file is an allowlisted https URL, and no window handle is involved.
    let verb = HSTRING::from("open");
    let file = HSTRING::from(url);
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(verb.as_ptr()),
            PCWSTR(file.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // The shell's contract: the return value, read as an integer, is above 32
    // when the launch started; the handle type only dresses it up.
    let code = result.0 as usize;
    if code <= 32 {
        return Err(format!("ShellExecuteW failed with code {code} for {url}"));
    }
    Ok(())
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

    /// A release that answers *nothing* is not a release that came back clean: the
    /// walk drops a process it will not speak for, and the caller that read an
    /// empty list as success would forget the pin while the program stayed fixed to
    /// the carrier — the board having already dropped the wire, nothing later would
    /// come back for it.
    #[test]
    fn an_empty_answer_is_not_a_clean_release() {
        assert!(
            !released_cleanly(Ok(Vec::new()), "feed source"),
            "no verdict at all is not a verdict of released"
        );
        assert!(
            released_cleanly(Ok(vec![(7, ReleaseOutcome::Released)]), "feed source"),
            "one process answered, handed back"
        );
        assert!(
            !released_cleanly(Ok(vec![(7, ReleaseOutcome::Unknown)]), "feed target"),
            "a refusal is reported, not swallowed"
        );
        assert!(
            !released_cleanly(
                Ok(vec![(
                    7,
                    ReleaseOutcome::StillPinned("{0.0.0.00000000}.{a}".to_string())
                )]),
                "feed target"
            ),
            "and so is a named device it would not give up"
        );
        assert!(
            !released_cleanly(
                Err(audio::AudioError::Api("the service is gone".to_string())),
                "feed source"
            ),
            "a walk that could not be asked at all is not a clean one"
        );
    }

    /// A command that names no program cannot be carried out: every program-side
    /// key is the executable name, so a blank one is a rule nothing can read back
    /// or forget later.
    #[test]
    fn a_command_that_names_no_program_is_refused() {
        assert!(require_exe_name("a route", "game.exe").is_ok());
        assert!(require_exe_name("a route", "").is_err());
        assert!(
            require_exe_name("a route", "   ").is_err(),
            "a name of nothing but spaces is a blank key beside every session"
        );
    }

    /// A release that was superseded is neither a hand-back nor a release the
    /// service refused, and every caller has to be able to tell it apart from both:
    /// read as a hand-back it forgets a pin that is still standing, read as a
    /// refusal it writes the default device over the newer route that won the slot.
    #[test]
    fn a_superseded_release_is_neither_a_hand_back_nor_a_refusal_to_fall_back_on() {
        let superseded = vec![(7, ReleaseOutcome::Superseded)];
        assert!(
            superseded_release(&superseded),
            "the stop and the rollback both sort on this"
        );
        assert!(
            !released_cleanly(Ok(superseded.clone()), "feed source"),
            "and it is never read as clean, so a pin is never forgotten behind it"
        );
        assert!(
            !superseded_release(&[(7, ReleaseOutcome::Released)]),
            "a release that did run is not this"
        );
        assert!(
            !superseded_release(&[(7, ReleaseOutcome::StillPinned("device".to_string()))]),
            "and neither is one the service would not answer for — that one keeps its fallback"
        );
        assert!(
            !superseded_release(&[]),
            "an empty answer is the sweep's own problem, not a superseded one"
        );
    }
}
