//! Tauri command handlers.

use log::info;
use tauri::State;

use crate::audio;
use crate::config::RouteConfig;

/// List all active render (playback) devices.
#[tauri::command]
pub fn list_devices() -> Result<Vec<audio::AudioDevice>, String> {
    info!("cmd: list_devices");
    audio::devices::enumerate_render_devices()
}

/// List all active audio sessions (processes with audio).
#[tauri::command]
pub fn list_sessions() -> Result<Vec<audio::AudioSession>, String> {
    info!("cmd: list_sessions");
    audio::sessions::enumerate_sessions()
}

/// Set the default audio device for a process.
#[tauri::command]
pub fn set_route(device_id: String, pid: u32, role: String) -> Result<(), String> {
    info!("cmd: set_route device={device_id} pid={pid} role={role}");

    let role = parse_role(&role);

    audio::routing::set_process_default_device(&device_id, pid, role)
}

/// Set the system-wide default render device.
#[tauri::command]
pub fn set_default_device(device_id: String, role: String) -> Result<(), String> {
    info!("cmd: set_default_device device={device_id} role={role}");
    audio::routing::set_default_device(&device_id, parse_role(&role))
}

fn parse_role(role: &str) -> audio::Role {
    match role {
        "console" => audio::Role::Console,
        "multimedia" => audio::Role::Multimedia,
        "communications" => audio::Role::Communications,
        _ => audio::Role::All,
    }
}

/// Set route and remember it for the exe.
#[tauri::command]
pub fn set_route_remember(
    device_id: String,
    pid: u32,
    role: String,
    exe_name: String,
    config: State<'_, RouteConfig>,
) -> Result<(), String> {
    info!("cmd: set_route_remember device={device_id} pid={pid} exe={exe_name}");

    let role = parse_role(&role);

    audio::routing::set_process_default_device(&device_id, pid, role)?;

    config.save_route(&exe_name, &device_id)?;
    info!("remembered route: {exe_name} -> {device_id}");
    Ok(())
}

/// Get all remembered routes.
#[tauri::command]
pub fn get_remembered_routes(config: State<'_, RouteConfig>) -> Vec<(String, String)> {
    config.get_all_routes()
}

/// Clear a remembered route.
#[tauri::command]
pub fn clear_route(exe_name: String, config: State<'_, RouteConfig>) -> Result<(), String> {
    config.remove_route(&exe_name)
}
