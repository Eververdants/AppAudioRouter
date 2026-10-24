//! The parts of the app that are not audio: the tray's preferences and labels,
//! the logon startup entry, what the window should say about this install, and the
//! only pages this process ever hands to the shell.
//!
//! The two page commands are the whole outbound boundary of this module: the
//! frontend names a **key** and nothing else, and `CARRIER_PAGES` / `HELP_PAGES`
//! here decide the URL, so no user-controlled string ever reaches
//! `ShellExecuteW`. An unknown key is refused rather than opened. The startup
//! entry is the only registry write in the app and stays in `HKCU`.
//!
//! The tray menu's labels come from the frontend because that is where the
//! language lives; the check mark on the startup item does not, because the
//! registry is the truth for it and the tray must show what the settings page
//! would.

use log::info;
use tauri::{AppHandle, State};

use crate::config::AppSettings;
use crate::install::{StartupNotice, StartupNoticeState};

// ---------------------------------------------------------------- shell

/// Whether closing the window hides it to the tray instead of quitting.
#[tauri::command]
pub fn get_close_to_tray(settings: State<'_, AppSettings>) -> bool {
    settings.close_to_tray()
}

/// Set the close-to-tray preference.
#[tauri::command]
pub fn set_close_to_tray(enabled: bool, settings: State<'_, AppSettings>) -> Result<(), String> {
    info!("cmd: set_close_to_tray enabled={enabled}");
    settings.set_close_to_tray(enabled)
}

/// Whether the app is registered to start at logon.
#[tauri::command]
pub fn get_autostart() -> Result<bool, String> {
    crate::autostart::is_enabled()
}

/// Register or unregister the logon startup entry.
#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<(), String> {
    info!("cmd: set_autostart enabled={enabled}");
    crate::autostart::set_enabled(enabled)
}

/// True when Windows launched this instance at logon.
///
/// The startup entry carries `--hidden` so a boot does not put a window in front
/// of the user; the frontend asks this before it reveals itself.
#[tauri::command]
pub fn is_silent_launch() -> bool {
    crate::autostart::is_silent_launch()
}

/// Push the tray menu's labels in the frontend's language, and the startup
/// item's check mark — the registry is the truth for that one, and the tray
/// shows what the settings page would.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn set_tray_labels(
    show: String,
    open_settings: String,
    autostart: String,
    autostart_checked: bool,
    stop_all: String,
    quit: String,
    app: AppHandle,
) -> Result<(), String> {
    crate::tray::set_labels(
        &app,
        &show,
        &open_settings,
        &autostart,
        autostart_checked,
        &stop_all,
        &quit,
    )
}

// ---------------------------------------------------------------- launch notice

/// What the window should say about this install, if anything.
///
/// Either it is the first launch of a fresh install, or an earlier version ran
/// here and may have left per-app endpoint assignments behind — the leftovers
/// 2.1.1 fixes, which nothing in the app can tell apart from assignments the user
/// made by hand.
#[tauri::command]
pub fn get_startup_notice(state: State<'_, StartupNoticeState>) -> Option<StartupNotice> {
    state.notice()
}

/// Record that this version has run, so the notice is not shown again.
#[tauri::command]
pub fn ack_startup_notice(state: State<'_, StartupNoticeState>) -> Result<(), String> {
    info!("cmd: ack_startup_notice");
    state.ack()
}

// ------------------------------------------------- carrier download pages

/// The download pages the carrier hint may point at. The mapping lives on this
/// side on purpose: the frontend names a driver key, never a URL, so nothing
/// user-controlled ever reaches the shell.
const CARRIER_PAGES: &[(&str, &str)] = &[
    ("vb-cable", "https://vb-audio.com/Cable/"),
    ("voicemeeter", "https://vb-audio.com/Voicemeeter/"),
];

/// Open a known loopback driver's download page in the user's browser.
#[tauri::command]
pub fn open_carrier_download(key: &str) -> Result<(), String> {
    info!("cmd: open_carrier_download {key}");
    let Some((_, url)) = CARRIER_PAGES.iter().find(|(name, _)| *name == key) else {
        return Err(format!("unknown carrier page key: {key}"));
    };
    open_in_browser(url)
}

/// The reference pages the About section points at. The same bargain as the
/// driver pages: the frontend names a key, never a URL, so nothing
/// user-controlled reaches the shell. The tour is gone once acknowledged and
/// there is no other documentation inside the window, so this is where a user
/// stuck on 未接通 can be sent.
const HELP_PAGES: &[(&str, &str)] = &[
    (
        "readme",
        "https://github.com/Eververdants/AppAudioRouter#readme",
    ),
    (
        "readme-zh",
        "https://github.com/Eververdants/AppAudioRouter/blob/main/README.zh-CN.md",
    ),
];

/// Open a reference page in the user's browser.
#[tauri::command]
pub fn open_help_page(key: &str) -> Result<(), String> {
    info!("cmd: open_help_page {key}");
    let Some((_, url)) = HELP_PAGES.iter().find(|(name, _)| *name == key) else {
        return Err(format!("unknown help page key: {key}"));
    };
    open_in_browser(url)
}

/// Hand a URL to the shell's "open" verb; the browser association decides
/// where it lands, and this process never sees the browser.
fn open_in_browser(url: &str) -> Result<(), String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    // SAFETY: the strings outlive the call, the verb is the literal "open" and
    // the file is an allowlisted https URL, and no window handle is involved.
    let verb = HSTRING::from("open");
    let file = HSTRING::from(url);
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(verb.as_ptr()),
            PCWSTR(file.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // The shell's contract: the return value, read as an integer, is above 32
    // when the launch started; the handle type only dresses it up.
    let code = result.0 as usize;
    if code <= 32 {
        return Err(format!("ShellExecuteW failed with code {code} for {url}"));
    }
    Ok(())
}
