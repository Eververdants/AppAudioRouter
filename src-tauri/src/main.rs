// Prevents an extra console window on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod autostart;
mod commands;
mod config;
mod install;
mod single_instance;
mod tray;

use std::time::Duration;

use tauri::{AppHandle, Manager, WindowEvent};

/// How long to wait for the frontend to reveal the window before forcing it.
const REVEAL_FALLBACK: Duration = Duration::from_secs(5);

/// How long a shutdown waits for the audio service to release the endpoint
/// assignments this run wrote.
const RELEASE_ON_EXIT_TIMEOUT: Duration = Duration::from_millis(1500);

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

    // Read before the window is built: the webview profile of *this* launch
    // would otherwise look like proof that a version has run here before.
    let context = tauri::generate_context!();
    let version = context.package_info().version.to_string();
    let startup_notice = install::StartupNoticeState::for_launch(
        context.config().identifier.as_str(),
        version.as_str(),
    );

    tauri::Builder::default()
        .setup(move |app| {
            // Before anything else: two instances would race on the config files
            // and the audio devices, and every later step assumes it owns both.
            // A second launch lands in `acquire`'s `None` branch — it has already
            // asked the running instance to show its window — and exits quietly.
            let Some(guard) = single_instance::acquire(app.handle().clone()) else {
                // `exit` lives on the handle, not on `App` itself.
                app.handle().exit(0);
                return Ok(());
            };
            app.manage(guard);

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
            let sources = config::SourceVolumeConfig::load(app.handle())
                .map_err(|e| Box::new(std::io::Error::other(e)) as Box<dyn std::error::Error>)?;
            let sources = std::sync::Arc::new(sources);
            app.manage(sources.clone());
            let primary_volumes = config::PrimaryVolumeConfig::load(app.handle())
                .map_err(|e| Box::new(std::io::Error::other(e)) as Box<dyn std::error::Error>)?;
            let primary_volumes = std::sync::Arc::new(primary_volumes);
            app.manage(primary_volumes.clone());
            // The "send into" rules and the loopback pair that carries them.
            let feeds = config::FeedConfig::load(app.handle())
                .map_err(|e| Box::new(std::io::Error::other(e)) as Box<dyn std::error::Error>)?;
            app.manage(feeds);
            let feed_carrier = config::FeedCarrierConfig::load(app.handle())
                .map_err(|e| Box::new(std::io::Error::other(e)) as Box<dyn std::error::Error>)?;
            app.manage(feed_carrier);
            let settings = config::AppSettings::load(app.handle())
                .map_err(|e| Box::new(std::io::Error::other(e)) as Box<dyn std::error::Error>)?;
            app.manage(settings);
            // What each program's audio is measuring at. Every engine writes its
            // own program's level here and reads the others' from it, which is
            // what makes one program's level comparable with another's.
            let levels = std::sync::Arc::new(audio::levels::SourceLevels::new());
            app.manage(levels.clone());
            app.manage(audio::duplication::DuplicationManager::new(
                delays,
                volumes,
                sources,
                primary_volumes,
                levels,
            ));
            // Every per-app endpoint assignment this app writes is written down
            // here, so it can be taken back on stop and on quit: Windows keeps
            // the assignment after this process is gone, and a program left
            // pinned ignores the device the user picks afterwards.
            app.manage(audio::routing::PinnedRoutes::new());
            // Whether this is a first run or an update, and therefore whether the
            // window should say something about assignments an older version may
            // have left behind.
            app.manage(startup_notice);

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
            commands::get_process_icon,
            commands::set_route,
            commands::set_default_device,
            commands::get_default_device,
            commands::apply_route,
            commands::stop_route,
            commands::reset_pinned_endpoints,
            commands::release_stale_routes,
            commands::get_active_duplications,
            commands::set_device_delay,
            commands::get_device_delays,
            commands::get_delay_range,
            commands::set_delay_range,
            commands::get_remembered_routes,
            commands::clear_route,
            commands::set_device_volume,
            commands::get_device_volumes,
            commands::set_primary_volume,
            commands::get_primary_volumes,
            commands::set_source_volume,
            commands::get_source_volumes,
            commands::align_source_levels,
            commands::get_close_to_tray,
            commands::set_close_to_tray,
            commands::get_autostart,
            commands::set_autostart,
            commands::is_silent_launch,
            commands::set_tray_labels,
            commands::get_startup_notice,
            commands::ack_startup_notice,
            commands::list_capture_devices,
            commands::get_feed_carrier,
            commands::set_feed_carrier,
            commands::list_feeds,
            commands::set_feed_target,
            commands::remove_feed_target,
            commands::open_carrier_download,
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            // Quitting is the last chance to give the user's programs back: the
            // endpoint assignment this run wrote outlives the process, and one
            // left behind would keep a program on the device this app chose even
            // though the user switched to another one afterwards. (`ExitRequested`
            // covers both the tray's Quit and closing the last window.)
            if let tauri::RunEvent::ExitRequested { .. } = event {
                restore_session_volumes(app);
                release_pinned_routes(app);
            }
        });
}

/// Give every routed program its pre-route loudness back before quitting.
///
/// The session volume a route wrote for its primary device would otherwise
/// follow the program into its unrouted life — and the volume mixer remembers
/// the value for the next launch — so it is handed back the same way the
/// endpoint assignments are.
fn restore_session_volumes(app: &AppHandle) {
    if let Some(duplications) = app.try_state::<audio::duplication::DuplicationManager>() {
        duplications.restore_all_session_volumes();
    }
}

/// Release every endpoint assignment this run wrote, before the app goes away.
///
/// Best effort with a bounded wait, on a thread of its own: a slow audio service
/// must not keep the window from closing.
fn release_pinned_routes(app: &AppHandle) {
    let Some(pins) = app.try_state::<audio::routing::PinnedRoutes>() else {
        return;
    };
    // Taken, not copied: nothing will retry once the process is gone.
    let pids = pins.take_all();
    if pids.is_empty() {
        return;
    }
    let outcomes = audio::routing::release_pinned_blocking(pids, RELEASE_ON_EXIT_TIMEOUT);
    let stuck: Vec<String> = outcomes
        .iter()
        .filter(|(_, outcome)| *outcome != audio::routing::ReleaseOutcome::Released)
        .map(|(pid, _)| pid.to_string())
        .collect();
    if !stuck.is_empty() {
        log::warn!(
            "these processes still carry an endpoint assignment: {}",
            stuck.join(", ")
        );
    }
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
