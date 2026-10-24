//! Backend-side window and shell behaviour (`app-settings.json`).

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::file_io::{persist_json, read_or_default};

/// Window and shell behaviour the **native** side has to know about.
///
/// Theme, language and delay step are pure webview preferences and stay in
/// localStorage. These are read while handling a window event or writing the
/// startup registry key — possibly with no webview involved at all — so they
/// belong with the other backend settings.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct SettingsMap {
    /// Whether the close button hides the window to the tray instead of quitting.
    ///
    /// Off by default, which keeps the behaviour every version up to 2.1 had:
    /// closing the window takes the running duplications down with it.
    #[serde(default)]
    close_to_tray: bool,
}

/// Manages the shell settings file (interior mutability for Tauri State).
pub struct AppSettings {
    inner: Mutex<AppSettingsInner>,
}

struct AppSettingsInner {
    path: PathBuf,
    map: SettingsMap,
}

impl AppSettings {
    /// Load config from the app data directory.
    pub fn load(app_handle: &AppHandle) -> Result<Self, String> {
        let path = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| format!("app_data_dir failed: {e}"))?
            .join("app-settings.json");

        let map = read_or_default(&path);

        Ok(Self {
            inner: Mutex::new(AppSettingsInner { path, map }),
        })
    }

    /// Whether closing the window should hide it to the tray.
    pub fn close_to_tray(&self) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .map
            .close_to_tray
    }

    /// Set and persist the close-to-tray preference.
    pub fn set_close_to_tray(&self, enabled: bool) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.map.close_to_tray = enabled;
        inner.persist()
    }
}

impl AppSettingsInner {
    /// Persist to disk.
    fn persist(&self) -> Result<(), String> {
        persist_json(&self.path, &self.map)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_settings_default_to_quitting_on_close() {
        // A missing key — every config written before the tray existed — must not
        // change what the close button used to do.
        let map: SettingsMap = serde_json::from_str("{}").unwrap();
        assert!(!map.close_to_tray);
        let map: SettingsMap = serde_json::from_str(r#"{"close_to_tray":true}"#).unwrap();
        assert!(map.close_to_tray);
    }
}
