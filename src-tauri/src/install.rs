//! What this install has seen before.
//!
//! Windows keeps a per-app endpoint assignment after the program that wrote it
//! is gone. A version that stopped a route without releasing that assignment
//! (2.1.1 and earlier) can therefore leave a program stuck on one device: the
//! system default no longer moves it, and neither does a reboot. Nothing in the
//! app can tell such a leftover from an assignment the user made by hand in the
//! volume mixer, so the release that fixes it says so once — on the first launch
//! after the update — and offers the reset.
//!
//! Whether this is an update is decided **before the window exists**: the
//! evidence is the two directories this app's own files live in.
//!
//! - `%APPDATA%\<identifier>` holds the JSON configuration, written only when
//!   something was actually saved.
//! - `%LOCALAPPDATA%\<identifier>\EBWebView` is WebView2's profile, which a single
//!   launch of any version creates.
//!
//! Checking after the window is built would read a first run as an update, since
//! the profile of *this* launch appears the moment the webview is created.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// File recording the version that last ran here.
const STATE_FILE: &str = "install-state.json";

/// WebView2's profile directory, inside the local app data directory.
const PROFILE_DIR: &str = "EBWebView";

/// What the window should tell the user on launch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StartupNotice {
    /// Which notice to show.
    pub kind: NoticeKind,
    /// Version that ran here last, when one was recorded.
    pub previous_version: Option<String>,
}

/// The two kinds of launch the app comments on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum NoticeKind {
    /// Nothing has ever run here: an empty machine.
    FirstRun,
    /// An earlier version ran here, so it may have left assignments behind.
    Upgrade,
}

#[derive(Debug, Deserialize, Serialize)]
struct StateFile {
    last_version: Option<String>,
}

/// The directories that tell an update from a first run.
pub struct InstallProbe {
    /// `%APPDATA%\<identifier>`: this app's own files.
    app_dir: Option<PathBuf>,
    /// `%LOCALAPPDATA%\<identifier>`: WebView2's files.
    local_dir: Option<PathBuf>,
}

impl InstallProbe {
    pub fn new(identifier: &str) -> Self {
        // Derived from the environment rather than from Tauri's path API: this
        // runs before the app exists, which is the whole point.
        let join = |var: &str| std::env::var_os(var).map(|base| Path::new(&base).join(identifier));
        Self {
            app_dir: join("APPDATA"),
            local_dir: join("LOCALAPPDATA"),
        }
    }

    /// The version recorded by an earlier launch of this file's app.
    fn recorded_version(&self) -> Option<String> {
        let path = self.app_dir.as_ref()?.join(STATE_FILE);
        let content = std::fs::read_to_string(path).ok()?;
        let state: StateFile = serde_json::from_str(&content).ok()?;
        state.last_version
    }

    /// Whether any version of this app has run on this machine.
    ///
    /// Configuration alone is not enough — a user who never changed a setting
    /// has none of it — so the webview profile counts too. Its exact folder name
    /// is used because an installer is free to create the directory that holds
    /// it, while only a real launch creates the profile inside.
    fn ran_before(&self) -> bool {
        let configured = self.app_dir.as_ref().is_some_and(|dir| dir.exists());
        let launched = self
            .local_dir
            .as_ref()
            .is_some_and(|dir| dir.join(PROFILE_DIR).exists());
        configured || launched
    }

    /// What the window should say, if anything.
    pub fn notice(&self, current_version: &str) -> Option<StartupNotice> {
        match self.recorded_version() {
            // This version already ran here: the notice has been shown.
            Some(seen) if seen == current_version => None,
            Some(seen) => Some(StartupNotice {
                kind: NoticeKind::Upgrade,
                previous_version: Some(seen),
            }),
            // Nothing recorded: a version from before the file existed is an
            // update, and a machine with neither directory is a first run.
            None if self.ran_before() => Some(StartupNotice {
                kind: NoticeKind::Upgrade,
                previous_version: None,
            }),
            None => Some(StartupNotice {
                kind: NoticeKind::FirstRun,
                previous_version: None,
            }),
        }
    }

    /// Record that this version has run, so the notice is not shown again.
    pub fn record(&self, current_version: &str) -> Result<(), String> {
        let Some(dir) = &self.app_dir else {
            return Err("no roaming app data directory in the environment".to_string());
        };
        let state = StateFile {
            last_version: Some(current_version.to_string()),
        };
        // Same atomic write every config file gets: a crash mid-write must
        // leave the previous state standing, not a half-written file the next
        // launch cannot parse — that would turn one update notice into one
        // per launch.
        crate::config::persist_json(&dir.join(STATE_FILE), &state)
            .map_err(|e| format!("write {STATE_FILE} failed: {e}"))
    }
}

/// The notice for this launch, and the probe that can record it as shown.
pub struct StartupNoticeState {
    probe: InstallProbe,
    current_version: String,
    notice: Option<StartupNotice>,
    shown: std::sync::Mutex<bool>,
}

impl StartupNoticeState {
    pub fn new(identifier: &str, current_version: &str) -> Self {
        let probe = InstallProbe::new(identifier);
        let notice = probe.notice(current_version);
        Self {
            probe,
            current_version: current_version.to_string(),
            notice,
            shown: std::sync::Mutex::new(false),
        }
    }

    /// The notice to show, until the window has acknowledged it.
    pub fn notice(&self) -> Option<StartupNotice> {
        if *self.shown.lock().unwrap_or_else(|e| e.into_inner()) {
            return None;
        }
        self.notice.clone()
    }

    /// Mark the notice as done, so this version never shows it again.
    pub fn ack(&self) -> Result<(), String> {
        *self.shown.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.probe.record(&self.current_version)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(app_dir: Option<PathBuf>, local_dir: Option<PathBuf>) -> InstallProbe {
        InstallProbe { app_dir, local_dir }
    }

    #[test]
    fn an_empty_machine_is_a_first_run() {
        let dir = std::env::temp_dir().join("aar-install-probe-empty");
        let _ = std::fs::remove_dir_all(&dir);
        let notice = probe(Some(dir.join("roaming")), Some(dir.join("local")))
            .notice("2.1.1")
            .expect("a first run still says something");
        assert_eq!(notice.kind, NoticeKind::FirstRun);
    }

    #[test]
    fn a_webview_profile_means_an_earlier_version_ran_here() {
        let dir = std::env::temp_dir().join("aar-install-probe-launched");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("local").join(PROFILE_DIR)).unwrap();
        let notice = probe(Some(dir.join("roaming")), Some(dir.join("local")))
            .notice("2.1.1")
            .expect("an update is worth mentioning");
        assert_eq!(notice.kind, NoticeKind::Upgrade);
        assert_eq!(notice.previous_version, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_same_version_is_not_mentioned_twice() {
        let dir = std::env::temp_dir().join("aar-install-probe-acked");
        let _ = std::fs::remove_dir_all(&dir);
        let probe = probe(Some(dir.clone()), None);
        probe.record("2.1.1").unwrap();
        assert_eq!(probe.notice("2.1.1"), None);
        // The next version has something to say again.
        assert_eq!(
            probe
                .notice("2.2.0")
                .expect("an update says something")
                .kind,
            NoticeKind::Upgrade
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The frontend's `StartupNotice['kind']` union spells these out, so the
    /// wire names are part of the contract.
    #[test]
    fn the_kind_reaches_the_frontend_as_a_kebab_case_name() {
        let notice = StartupNotice {
            kind: NoticeKind::FirstRun,
            previous_version: None,
        };
        assert_eq!(
            serde_json::to_string(&notice).unwrap(),
            r#"{"kind":"first-run","previous_version":null}"#
        );
        let notice = StartupNotice {
            kind: NoticeKind::Upgrade,
            previous_version: Some("2.1.0".to_string()),
        };
        assert_eq!(
            serde_json::to_string(&notice).unwrap(),
            r#"{"kind":"upgrade","previous_version":"2.1.0"}"#
        );
    }

    #[test]
    fn a_configured_directory_without_a_record_is_an_update() {
        let dir = std::env::temp_dir().join("aar-install-probe-configured");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let notice = probe(Some(dir.clone()), None)
            .notice("2.1.1")
            .expect("an update is worth mentioning");
        assert_eq!(notice.kind, NoticeKind::Upgrade);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
