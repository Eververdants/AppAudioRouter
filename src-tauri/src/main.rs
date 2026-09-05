// Prevents an extra console window on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod commands;
mod config;

use config::RouteConfig;

fn main() {
    env_logger::init();

    tauri::Builder::default()
        .manage(RouteConfig::load)
        .invoke_handler(tauri::generate_handler![
            commands::list_devices,
            commands::list_sessions,
            commands::set_route,
            commands::set_route_remember,
            commands::get_remembered_routes,
            commands::clear_route,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
