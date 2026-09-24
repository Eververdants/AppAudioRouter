//! System tray icon and the close-to-tray behaviour it makes possible.
//!
//! A per-app router spends its life steering audio for programs the user has
//! already walked away from, so the window is a control panel rather than the
//! product. The tray is how it stays reachable once the window is out of the way:
//! left click (or the menu item) toggles the window, `Quit` is the only thing that
//! tears the running routes down.

use log::warn;
use tauri::menu::{Menu, MenuEvent, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

/// Tray identifier, used to look the icon up again.
pub const TRAY_ID: &str = "main";
/// Menu id for showing or hiding the window.
pub const SHOW_ITEM: &str = "tray-show";
/// Menu id for leaving the app for good.
pub const QUIT_ITEM: &str = "tray-quit";

/// Labels before the frontend has pushed the localized ones.
const DEFAULT_SHOW_LABEL: &str = "Show / hide App Audio Router";
const DEFAULT_QUIT_LABEL: &str = "Quit";

/// The tray's own menu items, kept so their text can follow the UI language.
pub struct TrayMenu {
    show: MenuItem<Wry>,
    quit: MenuItem<Wry>,
}

/// Icon pixels, decoded at compile time so no image decoder has to ship.
const TRAY_ICON: tauri::image::Image<'static> = tauri::include_image!("icons/32x32.png");

/// Create the tray icon and its menu.
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, SHOW_ITEM, DEFAULT_SHOW_LABEL, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT_ITEM, DEFAULT_QUIT_LABEL, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(TRAY_ICON)
        .tooltip("App Audio Router")
        .menu(&menu)
        // A left click toggles the window; the menu belongs to the right click.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| on_menu_event(app, &event))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_window(tray.app_handle());
            }
        })
        .build(app)?;

    app.manage(TrayMenu { show, quit });
    Ok(())
}

/// Replace the tray menu labels with the frontend's language.
pub fn set_labels(app: &AppHandle, show: &str, quit: &str) -> Result<(), String> {
    let Some(menu) = app.try_state::<TrayMenu>() else {
        return Err("the tray menu does not exist".to_string());
    };
    menu.show
        .set_text(show)
        .map_err(|e| format!("set_text(show) failed: {e}"))?;
    menu.quit
        .set_text(quit)
        .map_err(|e| format!("set_text(quit) failed: {e}"))?;
    Ok(())
}

/// React to a tray menu click.
fn on_menu_event(app: &AppHandle, event: &MenuEvent) {
    match event.id().as_ref() {
        SHOW_ITEM => toggle_window(app),
        QUIT_ITEM => app.exit(0),
        other => warn!("unhandled tray menu item: {other}"),
    }
}

/// Show the window, or hide it if it is already on screen.
fn toggle_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        reveal(&window);
    }
}

/// Bring the window on screen and give it the keyboard.
///
/// Also the path out of a logon launch that started hidden, so it un-minimizes:
/// a window restored from the tray that stayed minimized would look broken.
pub fn reveal(window: &tauri::WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}
