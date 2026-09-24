//! Tauri command handlers.

use std::sync::Arc;

use log::info;
use tauri::{AppHandle, State};

use crate::audio;
use crate::audio::duplication::DuplicationManager;
use crate::config::{AppSettings, DelayConfig, RouteConfig, VolumeConfig};

/// List all active render (playback) devices.
#[tauri::command]
pub fn list_devices() -> Result<Vec<audio::AudioDevice>, String> {
    info!("cmd: list_devices");
    audio::devices::enumerate_render_devices().map_err(|e| e.to_string())
}

/// List all active audio sessions (processes with audio).
#[tauri::command]
pub fn list_sessions() -> Result<Vec<audio::AudioSession>, String> {
    info!("cmd: list_sessions");
    audio::sessions::enumerate_sessions().map_err(|e| e.to_string())
}

/// Set the default audio device for a process.
#[tauri::command]
pub async fn set_route(device_id: String, pid: u32, role: String) -> Result<(), String> {
    info!("cmd: set_route device={device_id} pid={pid} role={role}");

    let role = parse_role(&role);

    audio::routing::set_process_default_device(&device_id, pid, role)
        .await
        .map_err(|e| e.to_string())
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
pub fn get_default_device() -> Result<audio::AudioDevice, String> {
    info!("cmd: get_default_device");
    audio::devices::get_default_render_device().map_err(|e| e.to_string())
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
    app: AppHandle,
) -> Result<(), String> {
    info!("cmd: apply_route pid={pid} exe={exe_name} devices={device_ids:?} remember={remember}");
    if device_ids.is_empty() {
        return Err("no devices selected".to_string());
    }

    // Primary: the OS-native per-app endpoint.
    audio::routing::set_process_default_device(&device_ids[0], pid, audio::Role::All)
        .await
        .map_err(|e| e.to_string())?;

    // Mirrors: software duplication to every further device. The engine reads
    // each device's configured delay and volume itself.
    duplications.stop(pid);
    if device_ids.len() > 1 {
        duplications
            .start(pid, &device_ids[0], device_ids[1..].to_vec(), &app)
            .map_err(|e| e.to_string())?;
    }

    if remember {
        config.save_route(&exe_name, &device_ids)?;
        info!("remembered route: {exe_name} -> {device_ids:?}");
    }
    Ok(())
}

/// Stop routing a process: halt any duplication engine and point the process
/// back at the current system default device.
#[tauri::command]
pub async fn stop_route(pid: u32, duplications: State<'_, DuplicationManager>) -> Result<(), String> {
    info!("cmd: stop_route pid={pid}");
    // Resolve the fallback endpoint before tearing down duplication: if the lookup
    // fails we return early and the app keeps playing to its current device
    // instead of being left with no active route at all.
    let default_device = audio::devices::get_default_render_device().map_err(|e| e.to_string())?;
    duplications.stop(pid);

    audio::routing::set_process_default_device(&default_device.id, pid, audio::Role::All)
        .await
        .map_err(|e| e.to_string())
}

/// PIDs with a live duplication engine.
#[tauri::command]
pub fn get_active_duplications(duplications: State<'_, DuplicationManager>) -> Vec<u32> {
    duplications.active_pids()
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
