//! What this install has seen before.
//!
//! Windows keeps a per-app endpoint assignment after the program that wrote it
//! is gone. 2.1.0 — the release that introduced those assignments — stopped a
//! route by rewriting the record without releasing it, and could leave a
//! program stuck on one device: the system default no longer moves it, and
//! neither does a reboot. Nothing in the app can tell such a leftover from an
//! assignment the user made by hand in the volume mixer, so the app says so
//! once — on the first launch after the update — and offers the reset.
//! **Only for 2.1.0**: every later release returns what it pins on all four
//! paths (stop, exit, the stale sweep, the reset), so a machine coming from
//! 2.1.1 or later has nothing to clean and is not asked, on this or on any
//! future update.
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

/// The only release whose launches could leave a per-app endpoint assignment
/// behind. The upgrade notice exists for it and for nothing else.
const LEFTOVER_VERSION: &str = "2.1.0";

/// Debug-only override for what this launch says: `first-run` or `upgrade`
/// bypasses the probe, so a machine that has already acknowledged once — which
/// is to say, every developer's machine — can still see the tour or the
/// warning. Release builds never read the variable.
#[cfg(debug_assertions)]
const FORCE_ENV: &str = "AAR_STARTUP_NOTICE";

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
            // The rule is the version, not the distance to it. The state file
            // postdates 2.1.0, so in the wild this arm is rarely the evidence —
            // the arm below is — but the rule stays total rather than inferred.
            Some(seen) if seen == LEFTOVER_VERSION => Some(StartupNotice {
                kind: NoticeKind::Upgrade,
                previous_version: Some(seen),
            }),
            // Anything else recorded (2.1.1 and on) released its own
            // allocations on every path. An upgrade from it has nothing to
            // reset and gets silence, not the same dialog every release.
            Some(_) => None,
            // Nothing recorded but the directories are here: a version from
            // before the file existed ran here — the era that closed with
            // 2.1.0, the release the reset is for.
            None if self.ran_before() => Some(StartupNotice {
                kind: NoticeKind::Upgrade,
                previous_version: None,
            }),
            // Neither directory exists: an empty machine.
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

    /// The notice this launch should show. Identical to `new` except that
    /// debug builds honour `AAR_STARTUP_NOTICE` (`first-run` / `upgrade`):
    /// a machine that has already acknowledged once can otherwise never see
    /// the wizard again — the state file is doing its job — which would make
    /// the tour effectively untestable. Acknowledging a forced notice still
    /// records the state file like any other.
    pub fn for_launch(identifier: &str, current_version: &str) -> Self {
        #[cfg(debug_assertions)]
        {
            if let Ok(forced) = std::env::var(FORCE_ENV) {
                let kind = match forced.as_str() {
                    "first-run" => Some(NoticeKind::FirstRun),
                    "upgrade" => Some(NoticeKind::Upgrade),
                    _ => None,
                };
                if let Some(kind) = kind {
                    return Self {
                        probe: InstallProbe::new(identifier),
                        current_version: current_version.to_string(),
                        notice: Some(StartupNotice {
                            kind,
                            previous_version: None,
                        }),
                        shown: std::sync::Mutex::new(false),
                    };
                }
            }
        }
        Self::new(identifier, current_version)
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

    /// No state file but the webview profile is here: the machine last ran a
    /// version from before the file existed — the era 2.1.0 closed. This is
    /// the arm that catches a 2.1.0 machine in the wild.
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
        probe.record("2.3.0").unwrap();
        assert_eq!(probe.notice("2.3.0"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 2.1.1 and later return what they pin on every path, so an upgrade from
    /// them has nothing to reset — and must not see the same dialog again on
    /// every future release.
    #[test]
    fn an_upgrade_from_2_1_1_or_later_is_not_asked() {
        let dir = std::env::temp_dir().join("aar-install-probe-post-2-1-0");
        let _ = std::fs::remove_dir_all(&dir);
        let probe = probe(Some(dir.clone()), None);
        probe.record("2.1.1").unwrap();
        assert_eq!(probe.notice("2.3.0"), None);
        probe.record("2.2.0").unwrap();
        assert_eq!(probe.notice("2.3.0"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Only 2.1.0 earns the notice. The state file postdates that release, so
    /// this arm states the rule in full rather than being the evidence the
    /// wild provides — a real 2.1.0 machine arrives through the probe below.
    #[test]
    fn a_recorded_2_1_0_is_offered_the_reset() {
        let dir = std::env::temp_dir().join("aar-install-probe-2-1-0");
        let _ = std::fs::remove_dir_all(&dir);
        let probe = probe(Some(dir.clone()), None);
        probe.record(LEFTOVER_VERSION).unwrap();
        let notice = probe
            .notice("2.3.0")
            .expect("2.1.0 is the version the reset is for");
        assert_eq!(notice.kind, NoticeKind::Upgrade);
        assert_eq!(notice.previous_version.as_deref(), Some("2.1.0"));
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
