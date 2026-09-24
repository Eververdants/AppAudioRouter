// Prevents an extra console window on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod autostart;
mod commands;
mod config;
mod tray;

use std::time::Duration;

use tauri::{AppHandle, Manager, WindowEvent};

/// How long to wait for the frontend to reveal the window before forcing it.
const REVEAL_FALLBACK: Duration = Duration::from_secs(5);

fn main() {
    // Release defaults to `warn` so per-session/device enumeration (which dumps
    // window titles and endpoint ids) never lands in a shipped log file; debug
    // builds stay at `info`. Override with RUST_LOG=app_audio_router=debug.
    let default_filter = if cfg!(debug_assertions) {
        "info"
    } else {
        "warn"
    };
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or(default_filter))
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            let route_config = config::RouteConfig::load(app.handle())
                .map_err(|e| Box::new(std::io::Error::other(e)) as Box<dyn std::error::Error>)?;
            app.manage(route_config);
            let delays = config::DelayConfig::load(app.handle())
                .map_err(|e| Box::new(std::io::Error::other(e)) as Box<dyn std::error::Error>)?;
            let delays = std::sync::Arc::new(delays);
            app.manage(delays.clone());
            let volumes = config::VolumeConfig::load(app.handle())
                .map_err(|e| Box::new(std::io::Error::other(e)) as Box<dyn std::error::Error>)?;
            let volumes = std::sync::Arc::new(volumes);
            app.manage(volumes.clone());
            let settings = config::AppSettings::load(app.handle())
                .map_err(|e| Box::new(std::io::Error::other(e)) as Box<dyn std::error::Error>)?;
            app.manage(settings);
            app.manage(audio::duplication::DuplicationManager::new(delays, volumes));

            // The window is a control panel; the tray is what keeps the app
            // reachable while it steers audio in the background.
            tray::build(app.handle()).map_err(|e| Box::new(e) as Box<dyn std::error::Error>)?;
            autostart::repair_if_drifted();
            audio::notifications::start(app.handle().clone());

            let silent = autostart::is_silent_launch();
            spawn_reveal_watchdog(app.handle().clone(), silent);
            Ok(())
        })
        .on_window_event(|window, event| {
            // The close button is the one gesture that could take the running
            // duplications down with it, so honour the preference before quitting.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let hide = window
                        .app_handle()
                        .state::<config::AppSettings>()
                        .close_to_tray();
                    if hide {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
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
            commands::set_device_volume,
            commands::get_device_volumes,
            commands::get_close_to_tray,
            commands::set_close_to_tray,
            commands::get_autostart,
            commands::set_autostart,
            commands::is_silent_launch,
            commands::set_tray_labels,
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
/// A logon launch (`silent`) is the one case where staying invisible is the
/// point, so the watchdog stands down and the tray becomes the only way in.
///
/// Spawned on the async runtime rather than a bare thread so the task is
/// cancelled on shutdown: holding an `AppHandle` in a sleeping thread would
/// otherwise keep the process alive after the user closes the window.
fn spawn_reveal_watchdog(app: AppHandle, silent: bool) {
    tauri::async_runtime::spawn(async move {
        if silent {
            return;
        }
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
