// Prevents an extra console window on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod commands;
mod config;

use std::time::Duration;

use tauri::{AppHandle, Manager};

/// How long to wait for the frontend to reveal the window before forcing it.
const REVEAL_FALLBACK: Duration = Duration::from_secs(5);

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            let route_config = config::RouteConfig::load(app.handle())
                .map_err(|e| Box::new(std::io::Error::other(e)) as Box<dyn std::error::Error>)?;
            app.manage(route_config);
            let delays = config::DelayConfig::load(app.handle())
                .map_err(|e| Box::new(std::io::Error::other(e)) as Box<dyn std::error::Error>)?;
            let delays = std::sync::Arc::new(delays);
            app.manage(delays.clone());
            app.manage(audio::duplication::DuplicationManager::new(delays));
            let volumes = config::VolumeConfig::load(app.handle())
                .map_err(|e| Box::new(std::io::Error::other(e)) as Box<dyn std::error::Error>)?;
            app.manage(std::sync::Arc::new(volumes));
            spawn_reveal_watchdog(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_devices,
            commands::list_sessions,
            commands::set_route,
            commands::set_default_device,
            commands::get_default_device,
            commands::apply_route,
            commands::stop_route,
            commands::get_active_duplications,
            commands::set_device_delay,
            commands::get_device_delays,
            commands::get_delay_range,
            commands::set_delay_range,
            commands::set_delay_sync,
            commands::get_delay_sync,
            commands::get_remembered_routes,
            commands::clear_route,
            commands::set_session_volume,
            commands::get_volume_limits,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Guarantees the window eventually becomes visible.
///
/// The main window is created hidden (`"visible": false`) so the user never
/// sees the unstyled shell while the webview boots; the frontend shows it once
/// its first frame has painted. If that call never arrives — a broken bundle, a
/// missing permission — this watchdog reveals the window anyway rather than
/// leaving the app running with no visible UI.
///
/// Spawned on the async runtime rather than a bare thread so the task is
/// cancelled on shutdown: holding an `AppHandle` in a sleeping thread would
/// otherwise keep the process alive after the user closes the window.
fn spawn_reveal_watchdog(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(REVEAL_FALLBACK).await;
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        if matches!(window.is_visible(), Ok(false)) {
            log::warn!("frontend did not reveal the window in time; showing it now");
            let _ = window.show();
        }
    });
}
