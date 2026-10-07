//! Tauri command handlers.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use log::{debug, info, warn};
use serde::Serialize;
use tauri::{AppHandle, State};

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
    pub pinned_device: Option<String>,
}

/// What a sweep of left-over assignments found.
#[derive(Debug, Serialize)]
pub struct ResetOutcome {
    /// Programs whose assignment was released.
    pub released: usize,
    /// Executable names still carrying an assignment the service would not drop.
    pub still_pinned: Vec<String>,
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

/// Set the default audio device for a process.
#[tauri::command]
pub async fn set_route(
    device_id: String,
    pid: u32,
    role: String,
    pins: State<'_, PinnedRoutes>,
) -> Result<(), String> {
    info!("cmd: set_route device={device_id} pid={pid} role={role}");

    let role = parse_role(&role);

    audio::routing::set_process_default_device(&device_id, pid, role)
        .await
        .map_err(|e| e.to_string())?;
    // Same bookkeeping as `apply_route`: the assignment outlives this app.
    pins.mark(pid, &exe_name_of(pid), &device_id);
    Ok(())
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

/// Set the system-wide default render device.
#[tauri::command]
pub async fn set_default_device(device_id: String, role: String) -> Result<(), String> {
    info!("cmd: set_default_device device={device_id} role={role}");
    audio::routing::set_default_device(&device_id, parse_role(&role))
        .await
        .map_err(|e| e.to_string())
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

/// Route a process to an ordered list of devices.
///
/// The first device becomes the process's native endpoint (all roles); every
/// further device receives a duplicated copy of the stream. When only one
/// device is given, any running duplication engine for the process is stopped.
///
/// Each device's configured delay is measured against the app's audio, so the
/// engine also needs the primary device's value: the earliest device of the
/// group is the reference the copies are held back from. The frontend orders
/// the list by delay, which normally puts the earliest device first.
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
    duplications: State<'_, DuplicationManager>,
    pins: State<'_, PinnedRoutes>,
    app: AppHandle,
) -> Result<u64, String> {
    info!("cmd: apply_route pid={pid} exe={exe_name} devices={device_ids:?} remember={remember}");
    if device_ids.is_empty() {
        return Err("no devices selected".to_string());
    }
    // A device named twice would be mirrored onto the very device the OS is
    // already playing natively: the program is then heard twice, offset by the
    // copy's own latency, which sounds like an echo rather than like a second
    // output. A remembered route read back from a hand-edited config is one way
    // to arrive here, so the check belongs at the boundary.
    let device_ids = dedupe_device_ids(device_ids);

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
    duplications.stop(pid);
    let generation = if device_ids.len() > 1 {
        duplications
            .start(
                pid,
                &exe_name,
                &device_ids[0],
                device_ids[1..].to_vec(),
                &app,
            )
            .map_err(|e| e.to_string())?
    } else {
        0
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
) -> Result<StopOutcome, String> {
    info!("cmd: stop_route pid={pid}");
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
    duplications.stop(pid);
    // Resolve the fallback endpoint before releasing the assignment: if the
    // assignment cannot be released, the program is pointed here so it keeps
    // playing where the user can hear it.
    let default_device = tokio::task::spawn_blocking(audio::devices::get_default_render_device)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    if sibling_routed {
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
        return Ok(StopOutcome {
            released: false,
            pinned_device: pinned,
        });
    }

    // Release the *render* half only: the capture half is a feed's, not a
    // route's, and a program that receives another program's sound must keep
    // receiving it when its own device route stops.
    match audio::routing::release_process_default_devices_flow(vec![pid], audio::Role::All, false)
        .await
    {
        Ok(outcomes) if outcomes.iter().all(|(_, o)| *o == ReleaseOutcome::Released) => {
            pins.forget(pid);
            info!("stopped PID {pid} and released its endpoint assignment");
            // The feeds this executable was holding back now get their moment:
            // the route owned the one per-app render slot, and every recorded
            // feed source of the executable — this PID's own feed as much as a
            // sibling session's — was waiting for it. Re-point each one's
            // render half at the carrier its pin recorded; the capture halves
            // were pinned when the rules were made. A source that has picked up
            // a new route in the meantime keeps its slot.
            if let Some(exe) = &released_exe {
                let routed_now: std::collections::HashSet<u32> =
                    pins.routed_pids().into_iter().collect();
                for (feed_pid, feed_exe, is_capture) in pins.feed_pins() {
                    if is_capture || !feed_exe.eq_ignore_ascii_case(exe) {
                        continue;
                    }
                    if routed_now.contains(&feed_pid) {
                        continue;
                    }
                    if let Some(render) = pins.feed_source_device_of(feed_pid) {
                        match audio::routing::set_process_default_device(
                            &render,
                            feed_pid,
                            audio::Role::All,
                        )
                        .await
                        {
                            Ok(()) => info!("feed of PID {feed_pid} resumed on its carrier"),
                            Err(e) => warn!("could not resume the feed of PID {feed_pid}: {e}"),
                        }
                    }
                }
            }
            Ok(StopOutcome {
                released: true,
                pinned_device: None,
            })
        }
        Ok(_) => {
            warn!("PID {pid} still carries an endpoint assignment after the release attempt");
            Ok(pin_to_default(pid, &default_device.id, &pins).await)
        }
        Err(e) => {
            // The policy object was unavailable, so nothing could be released;
            // fall back to the pre-2.1.1 behaviour rather than leaving the
            // program on the device it was routed to.
            warn!("releasing the endpoint assignment of PID {pid} failed: {e}");
            Ok(pin_to_default(pid, &default_device.id, &pins).await)
        }
    }
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
            }
        }
        Err(e) => {
            warn!("could not point PID {pid} at the default device: {e}");
            StopOutcome {
                released: false,
                pinned_device: None,
            }
        }
    }
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
    // Only a live route is holding its assignment on purpose. A program this run
    // handed back to the default — because Windows refused to release it at stop
    // time — is exactly the case the user is asking about, and nothing else can
    // reach it.
    let live_routes: HashSet<u32> = pins.routed_pids().into_iter().collect();
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
        // Only live routes speak for their executable here. A program this run
        // handed back to the default — recorded with a pin but no live route —
        // is exactly what the user is asking the reset to clear.
        for (pid, exe_name, _device) in pins.snapshot() {
            if live_routes.contains(&pid) {
                exes.insert(exe_name.to_ascii_lowercase());
            }
        }
        exes
    };
    let pids: Vec<u32> = sessions
        .iter()
        .map(|session| session.pid)
        .filter(|pid| !routed.contains(pid) && !live_routes.contains(pid))
        .filter(|pid| {
            audio::sessions::get_process_exe_name(*pid)
                .map(|name| !routed_exes.contains(&name.to_ascii_lowercase()))
                // A process whose name cannot be read has nothing in common
                // with a routed executable that is known of.
                .unwrap_or(true)
        })
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
            _ => still_pinned.push(
                names
                    .get(&pid)
                    .cloned()
                    .unwrap_or_else(|| format!("PID {pid}")),
            ),
        }
    }
    info!(
        "reset: released {released} assignment(s), {} left",
        still_pinned.len()
    );
    Ok(ResetOutcome {
        released,
        still_pinned,
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
/// Returns the executable names that were released, for the log.
#[tauri::command]
pub async fn release_stale_routes(pins: State<'_, PinnedRoutes>) -> Result<Vec<String>, String> {
    let pinned = pins.snapshot();
    if pinned.is_empty() {
        return Ok(Vec::new());
    }
    let sessions = tokio::task::spawn_blocking(audio::sessions::enumerate_sessions)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    let live_pids: HashSet<u32> = sessions.iter().map(|session| session.pid).collect();
    let mut live_by_exe: HashMap<String, u32> = HashMap::new();
    for session in &sessions {
        live_by_exe
            .entry(session.exe_name.to_ascii_lowercase())
            .or_insert(session.pid);
    }
    // Snapshot, not the live map: the sweep below drops entries as it goes, and
    // a PID it drops is never the one it is about to hand the assignment to.
    // Only a live route counts as ours here: an entry handed back to the default
    // has nothing left to protect.
    let ours: HashSet<u32> = pins.routed_pids().into_iter().collect();
    // The assignment is stored per executable, and the PID it would be handed to
    // need not be the PID of ours — a browser plays through whichever of its
    // processes Windows lists first. What decides is whether that *executable*
    // still has a live route of ours: clearing it through any of its processes
    // would take that route's primary endpoint away, leaving the mirrors playing
    // while the program quietly fell back to the system default.
    let mut routed_exes: HashSet<String> = HashSet::new();
    for (pid, exe_name, _) in &pinned {
        if ours.contains(pid) && live_pids.contains(pid) {
            routed_exes.insert(exe_name.to_ascii_lowercase());
        }
    }

    let mut released: Vec<String> = Vec::new();
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
        if ours.contains(&relaunched_pid) || routed_exes.contains(&exe_name.to_ascii_lowercase()) {
            pins.forget(pid);
            continue;
        }
        let outcomes =
            audio::routing::release_process_default_devices(vec![relaunched_pid], audio::Role::All)
                .await
                .map_err(|e| e.to_string())?;
        if outcomes
            .iter()
            .all(|(_, outcome)| *outcome == ReleaseOutcome::Released)
        {
            pins.forget(pid);
            info!("released the assignment {exe_name} was left on by an earlier route");
            // Several stale PIDs can share one executable; the log wants the
            // name once, not once per PID.
            if !released.contains(&exe_name) {
                released.push(exe_name);
            }
        }
    }
    // Feed pins whose program is gone are bookkeeping with nothing to hold:
    // the endpoints they name died with the process. The rule itself stays in
    // the feed memory — it is the user's, not the process's — so the sweep
    // drops only the pin.
    for (pid, _exe, _capture) in pins.feed_pins() {
        if !live_pids.contains(&pid) {
            pins.forget_feed_source(pid);
            pins.forget_feed_capture(pid);
        }
    }
    Ok(released)
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
/// configured range is rejected.
#[tauri::command]
pub fn set_device_delay(
    device_id: String,
    delay_ms: i32,
    delays: State<'_, Arc<DelayConfig>>,
    duplications: State<'_, DuplicationManager>,
) -> Result<(), String> {
    info!("cmd: set_device_delay device={device_id} delay={delay_ms}ms");
    delays.set(&device_id, delay_ms)?;
    duplications.update_delay(&device_id, delay_ms);
    Ok(())
}

/// All configured device delays as `(device_id, delay_ms)` pairs.
#[tauri::command]
pub fn get_device_delays(delays: State<'_, Arc<DelayConfig>>) -> Vec<(String, i32)> {
    delays.all()
}

/// Largest magnitude a delay may be set to, in milliseconds.
#[tauri::command]
pub fn get_delay_range(delays: State<'_, Arc<DelayConfig>>) -> u32 {
    delays.range_ms()
}

/// Set the delay range. Stored values outside the new bound are clamped, so
/// live engines are refreshed as well.
#[tauri::command]
pub fn set_delay_range(
    range_ms: u32,
    delays: State<'_, Arc<DelayConfig>>,
    duplications: State<'_, DuplicationManager>,
) -> Result<(), String> {
    info!("cmd: set_delay_range range=±{range_ms}ms");
    delays.set_range_ms(range_ms)?;
    duplications.reload_delays();
    Ok(())
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
#[tauri::command]
pub fn set_primary_volume(
    exe_name: String,
    percent: u32,
    primaries: State<'_, Arc<PrimaryVolumeConfig>>,
    duplications: State<'_, DuplicationManager>,
) -> Result<(), String> {
    info!("cmd: set_primary_volume exe={exe_name} volume={percent}%");
    primaries.set(&exe_name, percent)?;
    duplications.update_primary_volume(&exe_name, percent);
    Ok(())
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

fn parse_role(role: &str) -> audio::Role {
    match role {
        "console" => audio::Role::Console,
        "multimedia" => audio::Role::Multimedia,
        "communications" => audio::Role::Communications,
        _ => audio::Role::All,
    }
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

/// Push the tray menu labels in the frontend's language.
#[tauri::command]
pub fn set_tray_labels(show: String, quit: String, app: AppHandle) -> Result<(), String> {
    crate::tray::set_labels(&app, &show, &quit)
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
    /// True when the endpoints were pinned and sound can move.
    pub delivered: bool,
    /// Why it could not be delivered, when it could not: `no_carrier` — no
    /// loopback pair is configured; `source_routed` — the source's per-app
    /// render slot belongs to a device route, so the rule is recorded and the
    /// feed resumes when that route stops.
    pub reason: Option<FeedBlockReason>,
}

/// Why a recorded feed is not moving sound.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedBlockReason {
    NoCarrier,
    SourceRouted,
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
/// Delivered by pinning the source's render endpoint to the carrier's playback
/// side and the target's capture endpoint to its recording side; both pins are
/// written down so they can be handed back, and the rule itself is written to
/// the feed memory so it survives a restart.
///
/// The per-app endpoint the audio service keeps is a single slot per data flow:
/// while the source's executable is routed to an output device — by this very
/// process or by a sibling session — that slot belongs to the device route, and
/// overwriting it would silently take the route's primary endpoint away. In
/// that case the target's capture half is pinned now and the render half is
/// recorded as an intent, and the rule is reported as `source_routed`:
/// `stop_route` re-pins the render half from that record when the route frees
/// the slot.
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
    duplications: State<'_, DuplicationManager>,
    pins: State<'_, PinnedRoutes>,
) -> Result<FeedOutcome, String> {
    info!("cmd: set_feed_target {source_exe} ({source_pid}) -> {target_exe} ({target_pid})");
    if source_pid == 0 || target_pid == 0 || source_pid == target_pid {
        return Err("a feed needs two distinct processes".to_string());
    }
    if source_exe.eq_ignore_ascii_case(&target_exe) {
        return Err("a program cannot be fed into itself".to_string());
    }
    // The rule is recorded first: an undeliverable feed is still the user's
    // decision, and the board shows it with the reason it is quiet. Recording
    // is cheap and idempotent.
    feeds.add(&source_exe, &target_exe)?;

    let pair = carrier.get();
    let (Some(render), Some(capture)) = (pair.render.clone(), pair.capture.clone()) else {
        return Ok(FeedOutcome {
            delivered: false,
            reason: Some(FeedBlockReason::NoCarrier),
        });
    };

    // Is the source's render slot owned by a device route of ours? The audio
    // service keeps the per-app endpoint **per executable**, so a route held
    // by a sibling process of the same program occupies the slot all the same
    // — writing the carrier over it would take the live route's primary
    // endpoint away while its mirrors kept playing.
    let source_routed = (pins.holds(source_pid) && pins.device_of(source_pid).is_some())
        || pins.exe_routed_elsewhere(source_pid, &source_exe)
        || duplications.exe_duplicated_elsewhere(source_pid);

    // The capture half is the target's own endpoint and has nothing to do with
    // the source's route, so it is pinned now whichever way the render half
    // goes — a suspended feed is then one pin away from delivering, and
    // stopping that route (which re-pins the render half from the bookkeeping
    // below) completes it.
    if let Err(e) =
        audio::routing::set_process_default_capture_device(&capture, target_pid, audio::Role::All)
            .await
    {
        // The frontend rolls its optimistic write back on an error, so the
        // rule this call recorded must go too, or the next launch would
        // resurrect a feed the UI does not show.
        let _ = feeds.remove(&source_exe, &target_exe);
        return Err(e.to_string());
    }
    pins.mark_feed_capture(target_pid, &target_exe, &capture);
    // The render half is what the route may be holding. The pin is recorded
    // either way — delivered or suspended — because it is what `stop_route`
    // reads when the route frees the slot: the endpoint to re-point the
    // source at.
    pins.mark_feed(source_pid, &source_exe, &render);
    if source_routed {
        return Ok(FeedOutcome {
            delivered: false,
            reason: Some(FeedBlockReason::SourceRouted),
        });
    }

    if let Err(e) =
        audio::routing::set_process_default_device(&render, source_pid, audio::Role::All).await
    {
        // Same contract as above: the UI has already forgotten this feed, so
        // the halves written so far go back and the rule with them. Each
        // release is guarded by the rules that remain — the endpoints are
        // shared per executable, and another rule may still need them.
        let still_sources = feeds.all().iter().any(|(src, tgt)| {
            src.eq_ignore_ascii_case(&source_exe) && !tgt.eq_ignore_ascii_case(&target_exe)
        });
        let still_targets = feeds.all().iter().any(|(src, tgt)| {
            tgt.eq_ignore_ascii_case(&target_exe) && !src.eq_ignore_ascii_case(&source_exe)
        });
        if !still_sources {
            let _ = audio::routing::release_process_default_devices_flow(
                vec![source_pid],
                audio::Role::All,
                false,
            )
            .await;
            pins.forget_feed_source(source_pid);
        }
        if !still_targets && pins.feed_capture_of(target_pid).is_some() {
            let _ = audio::routing::release_process_default_devices_flow(
                vec![target_pid],
                audio::Role::All,
                true,
            )
            .await;
            pins.forget_feed_capture(target_pid);
        }
        let _ = feeds.remove(&source_exe, &target_exe);
        return Err(e.to_string());
    }
    Ok(FeedOutcome {
        delivered: true,
        reason: None,
    })
}

/// Take one feed rule back: drop it from the memory and release the endpoints
/// the two ends were pinned to.
///
/// The release is per flow, so a source that is also routed to a device keeps
/// its render assignment — that one belongs to the route, not to the feed.
#[tauri::command]
pub async fn remove_feed_target(
    source_pid: u32,
    target_pid: u32,
    feeds: State<'_, FeedConfig>,
    pins: State<'_, PinnedRoutes>,
) -> Result<(), String> {
    info!("cmd: remove_feed_target {source_pid} -> {target_pid}");
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
    if !source_exe.is_empty() && !target_exe.is_empty() {
        feeds.remove(&source_exe, &target_exe)?;
    }
    // What is still on the books decides what this run may let go: a rule
    // from the same source or into the same target shares the endpoint pin,
    // and releasing it here would silence the feed that remains.
    let remaining = feeds.all();
    let source_still_needed = !source_exe.is_empty()
        && remaining
            .iter()
            .any(|(src, _)| src.eq_ignore_ascii_case(&source_exe));
    let target_still_needed = !target_exe.is_empty()
        && remaining
            .iter()
            .any(|(_, tgt)| tgt.eq_ignore_ascii_case(&target_exe));
    // Hand both ends back, but only the flow the feed owns: a routed source
    // keeps its render assignment (that one belongs to the route, and the
    // feed was recorded as suspended), and a target with no capture pin of
    // ours is left alone.
    if pins.feed_source_of(source_pid).is_some() && !pins.holds(source_pid) && !source_still_needed
    {
        let _ = audio::routing::release_process_default_devices_flow(
            vec![source_pid],
            audio::Role::All,
            false,
        )
        .await;
        pins.forget_feed_source(source_pid);
    }
    if pins.feed_capture_of(target_pid).is_some() && !target_still_needed {
        let _ = audio::routing::release_process_default_devices_flow(
            vec![target_pid],
            audio::Role::All,
            true,
        )
        .await;
        pins.forget_feed_capture(target_pid);
    }
    Ok(())
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
