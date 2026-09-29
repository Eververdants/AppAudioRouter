//! Tauri command handlers.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use log::{info, warn};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::audio;
use crate::audio::duplication::{ActiveRoute, DuplicationManager};
use crate::audio::routing::{PinnedRoutes, ReleaseOutcome};
use crate::config::{AppSettings, DelayConfig, RouteConfig, VolumeConfig};
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
    let exe_name = audio::sessions::get_process_exe_name(pid).unwrap_or_default();
    pins.mark(pid, &exe_name, &device_id);
    Ok(())
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
            .start(pid, &device_ids[0], device_ids[1..].to_vec(), &app)
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
    // Resolve the fallback endpoint before tearing down duplication: if the
    // assignment cannot be released, the program is pointed here so it keeps
    // playing where the user can hear it.
    let default_device = tokio::task::spawn_blocking(audio::devices::get_default_render_device)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    duplications.stop(pid);

    match audio::routing::release_process_default_devices(vec![pid], audio::Role::All).await {
        Ok(outcomes) if outcomes.iter().all(|(_, o)| *o == ReleaseOutcome::Released) => {
            pins.forget(pid);
            info!("stopped PID {pid} and released its endpoint assignment");
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
            let exe_name = audio::sessions::get_process_exe_name(pid).unwrap_or_default();
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
    let pids: Vec<u32> = sessions
        .iter()
        .map(|session| session.pid)
        .filter(|pid| !routed.contains(pid) && !live_routes.contains(pid))
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
                // stop time and is only now really released.
                pins.forget(pid);
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

/// Toggle delay compensation for all current and future engines.
#[tauri::command]
pub fn set_delay_sync(enabled: bool, duplications: State<'_, DuplicationManager>) {
    info!("cmd: set_delay_sync enabled={enabled}");
    duplications.set_delay_sync(enabled);
}

/// Whether delay compensation is currently enabled.
#[tauri::command]
pub fn get_delay_sync(duplications: State<'_, DuplicationManager>) -> bool {
    duplications.delay_sync()
}

/// Set a device's volume (percent, 0–100) and push it to any live engine using
/// that device.
///
/// The value is the device's share of the loudest device in its group: the
/// engine scales every mirror by `own / max`, so 100 leaves that device at the
/// level the app produced and smaller values attenuate it. Only the mirrors can
/// be scaled — the primary device is played by the OS — but its value still
/// counts towards the group's reference level.
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
