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

    match tauri::Builder::default()
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
                .map_err(|e| setup_failed("the route memory", e))?;
            app.manage(route_config);
            let delays = config::DelayConfig::load(app.handle())
                .map_err(|e| setup_failed("the device delays", e))?;
            let delays = std::sync::Arc::new(delays);
            app.manage(delays.clone());
            let volumes = config::VolumeConfig::load(app.handle())
                .map_err(|e| setup_failed("the device volumes", e))?;
            let volumes = std::sync::Arc::new(volumes);
            app.manage(volumes.clone());
            let sources = config::SourceVolumeConfig::load(app.handle())
                .map_err(|e| setup_failed("the source levels", e))?;
            let sources = std::sync::Arc::new(sources);
            app.manage(sources.clone());
            let primary_volumes = config::PrimaryVolumeConfig::load(app.handle())
                .map_err(|e| setup_failed("the primary volumes", e))?;
            let primary_volumes = std::sync::Arc::new(primary_volumes);
            app.manage(primary_volumes.clone());
            // The "send into" rules and the loopback pair that carries them.
            let feeds = config::FeedConfig::load(app.handle())
                .map_err(|e| setup_failed("the feed rules", e))?;
            app.manage(feeds);
            let feed_carrier = config::FeedCarrierConfig::load(app.handle())
                .map_err(|e| setup_failed("the feed carrier", e))?;
            app.manage(feed_carrier);
            let settings = config::AppSettings::load(app.handle())
                .map_err(|e| setup_failed("the app settings", e))?;
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
            // The delay wizard's tone player: one run at a time, cancellable.
            app.manage(audio::calibration::CalibrationState::default());
            // Whether this is a first run or an update, and therefore whether the
            // window should say something about assignments an older version may
            // have left behind.
            app.manage(startup_notice);

            // The window is a control panel; the tray is what keeps the app
            // reachable while it steers audio in the background. Losing it is
            // fatal on purpose: without the tray a hidden app has no way back
            // in and no way out, and an app that cannot be quit keeps its
            // assignments pinned until the process is killed.
            tray::build(app.handle()).map_err(|e| setup_failed("the tray", e))?;
            autostart::repair_if_drifted();
            audio::notifications::start(app.handle().clone());

            let silent = autostart::is_silent_launch();
            spawn_reveal_watchdog(app.handle().clone(), silent);
            Ok(())
        })
        .on_window_event(|window, event| {
            // The close button is the one gesture that could take the running
            // duplications down with it, so honour the preference before quitting.
            //
            // This cannot swallow a real quit: the tray's Quit goes through
            // `RunEvent::ExitRequested` and never closes a window, so the only
            // `CloseRequested` here is the user's ✕.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    // `try_state` rather than `state`: the window is created
                    // before `setup` has managed the settings, and a missing
                    // state would panic inside the close handler. With no
                    // setting to read the preference keeps its default, which is
                    // a close that really closes.
                    let hide = window
                        .app_handle()
                        .try_state::<config::AppSettings>()
                        .is_some_and(|settings| settings.close_to_tray());
                    if hide {
                        api.prevent_close();
                        if let Err(e) = window.hide() {
                            log::warn!("could not hide the window to the tray: {e}");
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_devices,
            commands::list_sessions,
            commands::get_process_icon,
            commands::get_default_device,
            commands::apply_route,
            commands::stop_route,
            commands::reset_pinned_endpoints,
            commands::forget_previous_settings,
            commands::release_stale_routes,
            commands::get_active_duplications,
            commands::set_device_delay,
            commands::get_device_delays,
            commands::calibration_start,
            commands::calibration_cancel,
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
            commands::open_help_page,
        ])
        .build(context)
    {
        // A release build is a `windows_subsystem` binary, so a panic here would
        // leave no trace at all and the user would only see that double clicking
        // did nothing. Say why in the log instead, and stop. Nothing is pinned
        // this early, so no release path is skipped by coming back here.
        Ok(app) => app.run(on_run_event),
        Err(e) => {
            log::error!("could not build the application: {e}");
        }
    }
}

/// Turns a startup failure into a logged one before handing it to Tauri.
///
/// Tauri panics when `setup` returns `Err`, and a release build has no console
/// to panic into: without this the app simply refuses to start and nothing ever
/// says why. Every failure reported here happens before any endpoint has been
/// written, so the missing `RunEvent::ExitRequested` costs nothing.
fn setup_failed(stage: &str, e: impl std::fmt::Display) -> Box<dyn std::error::Error> {
    log::error!("startup failed at {stage}: {e}");
    Box::new(std::io::Error::other(format!("{stage}: {e}")))
}

/// The cleanup every way out of this app has to pass through.
///
/// Both halves of the debt are handed back here — the per-app endpoint
/// assignments this run wrote, and the session volumes its engines claimed —
/// because both outlive the process if they are not.
///
/// `ExitRequested` covers the tray's Quit and the destruction of the last
/// window. `Exit` is matched as well, and that is not a duplicate: a Windows
/// logoff or shutdown never reaches `ExitRequested` at all (the event loop is
/// destroyed straight away), so an app started at logon and killed by signing
/// out would leave every routed program pinned to the device this app chose.
/// The two registers are *taken*, not read, so whichever event arrives second
/// finds nothing left to do and returns without touching the audio service.
fn on_run_event(app: &AppHandle, event: tauri::RunEvent) {
    match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => release_pinned_routes(app),
        _ => {}
    }
}

/// Release every endpoint assignment this run wrote, and give back every
/// session volume it claimed, before the app goes away.
///
/// Both are best effort with one bounded wait, on a thread of their own. The
/// endpoint release has always been guarded this way — a shutdown must never
/// hang on the audio service — and handing the loudness back is the same kind of
/// work: one device and session enumeration per engine, across the same service.
/// Left on this thread it could keep the window from closing, which is exactly
/// what the bound below exists to prevent.
///
/// The volumes go first: the endpoint release is the slower of the two, and a
/// program that keeps the device this app chose matters more than a program that
/// keeps the volume it chose.
fn release_pinned_routes(app: &AppHandle) {
    let Some(pins) = app.try_state::<audio::routing::PinnedRoutes>() else {
        return;
    };
    // Taken, not copied: nothing will retry once the process is gone.
    let pids = pins.take_all();
    // The loudness each engine promised to hand back, collected here so the
    // worker needs no reference to the manager — and taken once, so an engine's
    // own teardown cannot write the same value a second time.
    let restores = app
        .try_state::<audio::duplication::DuplicationManager>()
        .map(|manager| manager.take_pending_session_volume_restores())
        .unwrap_or_default();
    if pids.is_empty() && restores.is_empty() {
        return;
    }
    let outcomes = audio::routing::exit_cleanup(pids, RELEASE_ON_EXIT_TIMEOUT, move || {
        for (pid, percent) in restores {
            audio::duplication::restore_session_volume_now(pid, percent);
        }
    });
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
