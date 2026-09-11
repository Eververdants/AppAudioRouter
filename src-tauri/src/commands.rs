//! Tauri command handlers.

use log::info;
use tauri::{AppHandle, State};

use crate::audio;
use crate::audio::duplication::DuplicationManager;
use crate::config::RouteConfig;

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
pub fn set_route(device_id: String, pid: u32, role: String) -> Result<(), String> {
    info!("cmd: set_route device={device_id} pid={pid} role={role}");

    let role = parse_role(&role);

    audio::routing::set_process_default_device(&device_id, pid, role).map_err(|e| e.to_string())
}

/// Set the system-wide default render device.
#[tauri::command]
pub fn set_default_device(device_id: String, role: String) -> Result<(), String> {
    info!("cmd: set_default_device device={device_id} role={role}");
    audio::routing::set_default_device(&device_id, parse_role(&role)).map_err(|e| e.to_string())
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
#[tauri::command]
pub fn apply_route(
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
        .map_err(|e| e.to_string())?;

    // Mirrors: software duplication to every further device.
    duplications.stop(pid);
    if device_ids.len() > 1 {
        duplications
            .start(pid, device_ids[1..].to_vec(), &app)
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
pub fn stop_route(pid: u32, duplications: State<'_, DuplicationManager>) -> Result<(), String> {
    info!("cmd: stop_route pid={pid}");
    duplications.stop(pid);

    let default_device = audio::devices::get_default_render_device().map_err(|e| e.to_string())?;
    audio::routing::set_process_default_device(&default_device.id, pid, audio::Role::All)
        .map_err(|e| e.to_string())
}

/// PIDs with a live duplication engine.
#[tauri::command]
pub fn get_active_duplications(duplications: State<'_, DuplicationManager>) -> Vec<u32> {
    duplications.active_pids()
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
