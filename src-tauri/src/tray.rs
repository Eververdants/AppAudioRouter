//! System tray icon and the close-to-tray behaviour it makes possible.
//!
//! A per-app router spends its life steering audio for programs the user has
//! already walked away from, so the window is a control panel rather than the
//! product. The tray is how it stays reachable once the window is out of the way:
//! left click (or the menu item) toggles the window, `Quit` is the only thing that
//! tears the running routes down.
//!
//! The menu beyond that is the window's own work offered one press away —
//! opening the settings, stopping every route, the startup entry — and every
//! item of that kind is handed to the frontend rather than done here: the
//! routes live in the store, and the startup entry's switch is on the settings
//! page, so acting in this file would leave the two disagreeing about what
//! just happened.

use log::warn;
use serde::Serialize;
use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

/// Tray identifier, used to look the icon up again.
pub const TRAY_ID: &str = "main";
/// Menu id for showing or hiding the window.
pub const SHOW_ITEM: &str = "tray-show";
/// Menu id for revealing the window straight on the settings page.
pub const OPEN_SETTINGS_ITEM: &str = "tray-open-settings";
/// Menu id for the startup-entry check item.
pub const AUTOSTART_ITEM: &str = "tray-autostart";
/// Menu id for handing every routed program back to the system default.
pub const STOP_ALL_ITEM: &str = "tray-stop-all";
/// Menu id for leaving the app for good.
pub const QUIT_ITEM: &str = "tray-quit";

/// Event carrying a tray menu click to the frontend, which owns the state it
/// changes. Payload: [`TrayMenuAction`].
pub const TRAY_MENU_EVENT: &str = "tray-menu";

/// Which tray menu item was clicked, as the frontend reads it.
#[derive(Clone, Serialize)]
pub struct TrayMenuAction {
    /// One of `open-settings`, `toggle-autostart`, `stop-all`.
    pub action: &'static str,
}

/// Labels before the frontend has pushed the localized ones.
const DEFAULT_SHOW_LABEL: &str = "Show / hide App Audio Router";
const DEFAULT_OPEN_SETTINGS_LABEL: &str = "Open settings";
const DEFAULT_AUTOSTART_LABEL: &str = "Start with Windows";
const DEFAULT_STOP_ALL_LABEL: &str = "Stop all routes";
const DEFAULT_QUIT_LABEL: &str = "Quit";

/// The tray's own menu items, kept so their text can follow the UI language.
pub struct TrayMenu {
    show: MenuItem<Wry>,
    open_settings: MenuItem<Wry>,
    autostart: CheckMenuItem<Wry>,
    stop_all: MenuItem<Wry>,
    quit: MenuItem<Wry>,
}

/// Icon pixels, decoded at compile time so no image decoder has to ship.
const TRAY_ICON: tauri::image::Image<'static> = tauri::include_image!("icons/32x32.png");

/// Create the tray icon and its menu.
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, SHOW_ITEM, DEFAULT_SHOW_LABEL, true, None::<&str>)?;
    let open_settings = MenuItem::with_id(
        app,
        OPEN_SETTINGS_ITEM,
        DEFAULT_OPEN_SETTINGS_LABEL,
        true,
        None::<&str>,
    )?;
    let autostart = CheckMenuItem::with_id(
        app,
        AUTOSTART_ITEM,
        DEFAULT_AUTOSTART_LABEL,
        true,
        false,
        None::<&str>,
    )?;
    let stop_all = MenuItem::with_id(
        app,
        STOP_ALL_ITEM,
        DEFAULT_STOP_ALL_LABEL,
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, QUIT_ITEM, DEFAULT_QUIT_LABEL, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &open_settings, &autostart, &stop_all, &quit])?;

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

    app.manage(TrayMenu {
        show,
        open_settings,
        autostart,
        stop_all,
        quit,
    });
    Ok(())
}

/// Replace the tray menu labels with the frontend's language, and the startup
/// item's check mark with what the registry holds.
#[allow(clippy::too_many_arguments)]
pub fn set_labels(
    app: &AppHandle,
    show: &str,
    open_settings: &str,
    autostart: &str,
    autostart_checked: bool,
    stop_all: &str,
    quit: &str,
) -> Result<(), String> {
    let Some(menu) = app.try_state::<TrayMenu>() else {
        return Err("the tray menu does not exist".to_string());
    };
    let text = |what: &str, e: tauri::Error| format!("set_text({what}) failed: {e}");
    menu.show.set_text(show).map_err(|e| text("show", e))?;
    menu.open_settings
        .set_text(open_settings)
        .map_err(|e| text("open_settings", e))?;
    menu.autostart
        .set_text(autostart)
        .map_err(|e| text("autostart", e))?;
    menu.stop_all
        .set_text(stop_all)
        .map_err(|e| text("stop_all", e))?;
    menu.quit.set_text(quit).map_err(|e| text("quit", e))?;
    menu.autostart
        .set_checked(autostart_checked)
        .map_err(|e| format!("set_checked(autostart) failed: {e}"))?;
    Ok(())
}

/// React to a tray menu click.
fn on_menu_event(app: &AppHandle, event: &MenuEvent) {
    match event.id().as_ref() {
        SHOW_ITEM => toggle_window(app),
        QUIT_ITEM => app.exit(0),
        OPEN_SETTINGS_ITEM => {
            if let Some(window) = app.get_webview_window("main") {
                reveal(&window);
            }
            forward(app, "open-settings");
        }
        AUTOSTART_ITEM => forward(app, "toggle-autostart"),
        STOP_ALL_ITEM => forward(app, "stop-all"),
        other => warn!("unhandled tray menu item: {other}"),
    }
}

/// Hand a menu click to the frontend, which owns the state it changes.
fn forward(app: &AppHandle, action: &'static str) {
    if let Err(e) = app.emit(TRAY_MENU_EVENT, TrayMenuAction { action }) {
        warn!("could not deliver {TRAY_MENU_EVENT}: {e}");
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
