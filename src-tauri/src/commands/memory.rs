//! The rules this app learned: the remembered route list, one route forgotten,
//! and the "start clean" half of the tour's inherit question.
//!
//! These are reads and writes of the memory files, not of the audio graph — which
//! is why [`forget_previous_settings`] clears routes, feed rules, delays, device
//! shares and program levels together and deliberately leaves the per-app endpoint
//! assignments (that is [`super::release`]'s reset, with its own button, because it
//! reaches what the user set by hand), the primary volumes (a program's session
//! volume is the program's business, not this app's memory of it) and the shell
//! settings (close-to-tray and the startup entry are habits, not learned state).

use std::sync::Arc;

use log::info;
use tauri::State;

use crate::config::{DelayConfig, FeedConfig, RouteConfig, SourceVolumeConfig, VolumeConfig};

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
    // Every store gets its chance even when an earlier one fails: a `?` chain
    // would stop at the first refusal, leaving the later stores holding rules
    // the user was told are gone. What was not cleared is named.
    let failures: Vec<String> = [
        ("remembered routes", routes.clear().err()),
        ("feed rules", feeds.clear().err()),
        ("device delays", delays.clear().err()),
        ("device shares", volumes.clear().err()),
        ("program levels", sources.clear().err()),
    ]
    .into_iter()
    .filter_map(|(name, err)| err.map(|e| format!("{name}: {e}")))
    .collect();
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "some settings could not be cleared — {}",
            failures.join("; ")
        ))
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
