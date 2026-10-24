//! What is out there: devices, sessions, the apps holding windows, the icon of a
//! process, and the duplication engines this run is running.
//!
//! Every command here is a read-only enumeration, and each one hands its walk to a
//! blocking thread: the enumeration touches Core Audio (and, for an icon, the
//! process's own executable file), none of which belongs on the WebView2 main
//! thread. Nothing here is polled — the frontend asks at boot and again when
//! `audio::notifications` says the graph or a session moved.

use log::{debug, info};
use tauri::State;

use crate::audio;
use crate::audio::duplication::{ActiveRoute, DuplicationManager};

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

/// List every running app a person could name (a visible window, one entry per
/// executable), as feed-target candidates beyond the audio-session list.
///
/// Read-only and cheap; the frontend asks at boot and whenever the
/// add-destination picker opens, never on a timer.
#[tauri::command]
pub async fn list_window_apps() -> Result<Vec<audio::AudioSession>, String> {
    info!("cmd: list_window_apps");
    tokio::task::spawn_blocking(audio::sessions::enumerate_window_apps)
        .await
        .map_err(|e| e.to_string())?
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

/// Recording endpoints, for the carrier picker in settings.
#[tauri::command]
pub async fn list_capture_devices() -> Result<Vec<audio::AudioDevice>, String> {
    info!("cmd: list_capture_devices");
    tokio::task::spawn_blocking(audio::devices::enumerate_capture_devices)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Live duplication engines and their ordered device lists.
#[tauri::command]
pub fn get_active_duplications(duplications: State<'_, DuplicationManager>) -> Vec<ActiveRoute> {
    duplications.active_routes()
}
