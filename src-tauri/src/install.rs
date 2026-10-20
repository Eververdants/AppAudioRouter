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
/// behind. The reset offer inside the tour is for it and for nothing else.
const LEFTOVER_VERSION: &str = "2.1.0";

/// The release line the full-screen tour belongs to: the first launch on or
/// after it walks the user in, whichever version ran here before. That launch
/// also carries the one screen asking whether to keep the predecessor's
/// settings — the reason an upgrade is worth a tour at all, and the only thing
/// that separates it from a first run beyond the tour itself.
const WIZARD_VERSION: &str = "2.3.0";

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
    /// Whether that version could have left per-app endpoint assignments
    /// pinned — the one thing the tour's upgrade screen offers to clean.
    /// Nothing in the app can tell such a leftover from an assignment the user
    /// made by hand in the volume mixer, so it is an offer, never an action.
    pub leftover_endpoints: bool,
}

/// Whether `a` names an earlier release than `b`, component by component
/// (`2.2.9` below `2.3.0`, `2.3` equal to `2.3.0`). A component that is not a
/// number counts as zero, so a mangled record can never pass itself off as
/// newer than the tour's line and silence the wizard.
fn version_below(a: &str, b: &str) -> bool {
    let mut left = a.split('.').map(|p| p.parse::<u64>().unwrap_or(0));
    let mut right = b.split('.').map(|p| p.parse::<u64>().unwrap_or(0));
    loop {
        match (left.next(), right.next()) {
            (None, None) => return false,
            (l, r) => {
                let l = l.unwrap_or(0);
                let r = r.unwrap_or(0);
                if l != r {
                    return l < r;
                }
            }
        }
    }
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
    /// The probe for `identifier`, with both evidence directories taken from
    /// the environment — the app does not exist yet to ask.
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
    ///
    /// A blank is not a record. Answering "which version ran here" with an empty
    /// string would put nothing on the upgrade screen, and a record that says
    /// nothing must not be allowed to vouch for itself — the machine falls back
    /// to the evidence of its own directories, which is the conservative answer.
    fn recorded_version(&self) -> Option<String> {
        let path = self.app_dir.as_ref()?.join(STATE_FILE);
        let content = std::fs::read_to_string(path).ok()?;
        let state: StateFile = serde_json::from_str(&content).ok()?;
        state
            .last_version
            .map(|seen| seen.trim().to_string())
            .filter(|seen| !seen.is_empty())
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
            // The first launch on the tour's line — the machine's very first,
            // or one coming from anything older — walks the user in. A
            // predecessor below 2.1.1 may also have left endpoint assignments
            // behind, which the tour's upgrade screen offers to clean.
            Some(seen) if version_below(&seen, WIZARD_VERSION) => Some(StartupNotice {
                kind: NoticeKind::Upgrade,
                leftover_endpoints: seen == LEFTOVER_VERSION,
                previous_version: Some(seen),
            }),
            // Nothing recorded but the directories are here: a version from
            // before the file existed ran here — the era that closed with
            // 2.1.0, the release the reset is for. Nothing is known about
            // which of them it was, and the older half of that era is exactly
            // the half that pinned endpoints.
            None if self.ran_before() => Some(StartupNotice {
                kind: NoticeKind::Upgrade,
                previous_version: None,
                leftover_endpoints: true,
            }),
            // Neither directory exists: an empty machine.
            None => Some(StartupNotice {
                kind: NoticeKind::FirstRun,
                previous_version: None,
                leftover_endpoints: false,
            }),
            // Recorded, and already on the tour's line: there is nothing left
            // to walk through and nothing left to clean.
            Some(_) => None,
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
    /// Decide this launch's notice straight from the probe, with no override.
    pub fn new(identifier: &str, current_version: &str) -> Self {
        Self::from_probe(InstallProbe::new(identifier), current_version)
    }

    /// The state for a probe chosen by the caller.
    ///
    /// What `new` does with this machine's directories, done to any directories:
    /// the notice is decided from the record on disk, so this is the seam that
    /// lets a test aim the record at a temporary folder and ask whether the tour
    /// is offered twice.
    pub fn from_probe(probe: InstallProbe, current_version: &str) -> Self {
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
                            // A forced upgrade is for looking at the upgrade
                            // screen, reset offer included.
                            leftover_endpoints: kind == NoticeKind::Upgrade,
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
            .notice("2.3.0")
            .expect("a first run still says something");
        assert_eq!(notice.kind, NoticeKind::FirstRun);
        assert!(!notice.leftover_endpoints);
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
            .notice("2.3.0")
            .expect("an update is worth mentioning");
        assert_eq!(notice.kind, NoticeKind::Upgrade);
        assert_eq!(notice.previous_version, None);
        assert!(notice.leftover_endpoints);
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

    /// The first launch on the tour's line walks the user in whatever ran here
    /// before — that is what the screen asking about the predecessor's settings
    /// is for — but a predecessor from 2.1.1 on returned what it pinned on
    /// every path, so its screen has no reset to offer. Once the machine is on
    /// the line, later releases say nothing at all.
    #[test]
    fn the_first_launch_on_the_tour_line_is_walked_in() {
        let dir = std::env::temp_dir().join("aar-install-probe-post-2-1-0");
        let _ = std::fs::remove_dir_all(&dir);
        let probe = probe(Some(dir.clone()), None);
        for seen in ["2.1.1", "2.2.0", "2.2.9"] {
            probe.record(seen).unwrap();
            let notice = probe
                .notice("2.3.0")
                .expect("a machine walking into 2.3.0 is shown the tour");
            assert_eq!(notice.kind, NoticeKind::Upgrade);
            assert_eq!(notice.previous_version.as_deref(), Some(seen));
            assert!(!notice.leftover_endpoints);
        }
        probe.record("2.3.0").unwrap();
        assert_eq!(probe.notice("2.3.0"), None);
        probe.record("2.3.1").unwrap();
        assert_eq!(probe.notice("2.3.2"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Versions compare by their numbers: the record is user-editable, and one
    /// that parses as nothing must not pass itself off as newer than the tour's
    /// line and skip it.
    #[test]
    fn versions_compare_by_their_numbers() {
        assert!(version_below("2.2.9", "2.3.0"));
        assert!(!version_below("2.3", "2.3.0"));
        assert!(version_below("2.3.0", "2.3.1"));
        assert!(version_below("beta", "2.3.0"));
        assert!(!version_below("2.3.1", "2.3.0"));
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
        assert!(notice.leftover_endpoints);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The frontend's `StartupNotice['kind']` union spells these out, so the
    /// wire names are part of the contract.
    #[test]
    fn the_kind_reaches_the_frontend_as_a_kebab_case_name() {
        let notice = StartupNotice {
            kind: NoticeKind::FirstRun,
            previous_version: None,
            leftover_endpoints: false,
        };
        assert_eq!(
            serde_json::to_string(&notice).unwrap(),
            r#"{"kind":"first-run","previous_version":null,"leftover_endpoints":false}"#
        );
        let notice = StartupNotice {
            kind: NoticeKind::Upgrade,
            previous_version: Some("2.1.0".to_string()),
            leftover_endpoints: true,
        };
        assert_eq!(
            serde_json::to_string(&notice).unwrap(),
            r#"{"kind":"upgrade","previous_version":"2.1.0","leftover_endpoints":true}"#
        );
    }

    #[test]
    fn a_configured_directory_without_a_record_is_an_update() {
        let dir = std::env::temp_dir().join("aar-install-probe-configured");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let notice = probe(Some(dir.clone()), None)
            .notice("2.3.0")
            .expect("an update is worth mentioning");
        assert_eq!(notice.kind, NoticeKind::Upgrade);
        assert_eq!(notice.previous_version, None);
        assert!(notice.leftover_endpoints);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A record that names no version is no record. It must not be allowed to
    /// vouch for itself as a newer-than-the-tour predecessor: the machine falls
    /// back to the evidence of its own directories, which asks the conservative
    /// question instead of putting a blank version on the screen.
    #[test]
    fn a_blank_record_does_not_vouch_for_itself() {
        let dir = std::env::temp_dir().join("aar-install-probe-blank");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(STATE_FILE), r#"{"last_version":"  "}"#).unwrap();
        let notice = probe(Some(dir.clone()), None)
            .notice("2.3.0")
            .expect("a machine with our files on it is asked, not welcomed as new");
        assert_eq!(notice.kind, NoticeKind::Upgrade);
        assert_eq!(notice.previous_version, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The promise the record exists for, checked against the file rather than
    /// against the code: the tour is shown, the user answers it, and the answer
    /// is on disk — so the next launch of the same version has nothing to ask.
    #[test]
    fn the_tour_is_offered_once_because_the_ack_writes_the_record() {
        let dir = std::env::temp_dir().join("aar-install-state-ack");
        let _ = std::fs::remove_dir_all(&dir);
        let state = StartupNoticeState::from_probe(probe(Some(dir.clone()), None), "2.3.0");
        assert!(state.notice().is_some(), "an empty machine is walked in");
        state
            .ack()
            .expect("the record lands in the app's own directory");
        assert!(state.notice().is_none(), "an answered tour stays answered");
        let again = StartupNoticeState::from_probe(probe(Some(dir.clone()), None), "2.3.0");
        assert!(
            again.notice().is_none(),
            "the record on disk is what keeps the tour from coming back"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A tour whose record could not be written ends for this launch (the user
    /// answered it, and a window stuck on a dismissed tour is worse than a repeat
    /// question), but the next launch asks again rather than pretending this
    /// machine was ever walked through.
    #[test]
    fn an_ack_that_could_not_be_written_is_reported_and_not_adopted() {
        let dir = std::env::temp_dir().join("aar-install-state-blocked");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // A file where the record's directory would have to be: the write fails.
        std::fs::write(dir.join("blocker"), b"x").unwrap();
        let blocked = dir.join("blocker").join("roaming");
        let state = StartupNoticeState::from_probe(probe(Some(blocked.clone()), None), "2.3.0");
        assert!(state.notice().is_some());
        state
            .ack()
            .expect_err("the record has nowhere to go, and says so");
        assert!(
            state.notice().is_none(),
            "the window is not left on a tour the user already closed"
        );
        let again = StartupNoticeState::from_probe(probe(Some(blocked), None), "2.3.0");
        assert!(
            again.notice().is_some(),
            "an unrecorded answer is asked again, never reported as kept"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
