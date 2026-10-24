//! Feed memory: which program's output is sent into which program's input.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::file_io::{persist_json, read_or_default};

/// Feed memory: source exe name -> the exe names its audio is sent into.
///
/// "Send this program's sound into that program's input" is delivered by
/// pointing the source's render endpoint at a loopback pair's playback side
/// and the target's capture endpoint at the pair's recording side, so the rule
/// is stored per executable on both ends — the same ownership rule the device
/// routing uses, and the same reason: one browser holds a dozen processes and
/// only one of them needs the assignment.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct FeedMap {
    #[serde(default)]
    feeds: HashMap<String, Vec<String>>,
}

impl FeedMap {
    /// Record that `source_exe`'s audio is sent into `target_exe`'s input.
    ///
    /// The rule lands under the spelling already on file: an image name carries
    /// whatever case the launch used, so the same program can arrive once as
    /// `Chrome.exe` and once as `chrome.exe`, and two entries for one program
    /// is how a remembered feed ends up read twice — and how a removal that
    /// found the other spelling leaves an endpoint pinned behind.
    fn add_rule(&mut self, source_exe: &str, target_exe: &str) {
        let key = self
            .feeds
            .keys()
            .find(|name| name.eq_ignore_ascii_case(source_exe))
            .cloned()
            .unwrap_or_else(|| source_exe.to_string());
        let entry = self.feeds.entry(key).or_default();
        if !entry
            .iter()
            .any(|name| name.eq_ignore_ascii_case(target_exe))
        {
            entry.push(target_exe.to_string());
        }
    }

    /// Fold every case variant of one source executable into one entry, merging
    /// the targets each of them remembered.
    ///
    /// Same hazard [`RouteMap::consolidate_case_variants`] answers, with a
    /// different fold: a second spelling of one program lists its feeds twice on
    /// the settings page and restores twice at startup, while dropping either
    /// spelling's targets would silently un-make a rule the user set. Nothing
    /// here rewrites a key nobody touches again, so the fold happens on load.
    fn consolidate_case_variants(&mut self) {
        let mut names: Vec<String> = self.feeds.keys().cloned().collect();
        names.sort();
        let mut folded: Vec<(String, Vec<String>)> = Vec::new();
        let mut seen: HashMap<String, usize> = HashMap::new();
        for name in names {
            let Some(targets) = self.feeds.remove(&name) else {
                continue;
            };
            let lower = name.to_ascii_lowercase();
            let index = match seen.get(&lower).copied() {
                Some(index) => index,
                None => {
                    seen.insert(lower, folded.len());
                    folded.push((name, Vec::new()));
                    folded.len() - 1
                }
            };
            for target in targets {
                if !folded[index]
                    .1
                    .iter()
                    .any(|kept| kept.eq_ignore_ascii_case(&target))
                {
                    folded[index].1.push(target);
                }
            }
        }
        self.feeds = folded.into_iter().collect();
    }

    /// Drop one target from `source_exe`'s rule; a rule left empty is removed.
    ///
    /// Every case variant of the source's key goes, not just the first the map
    /// yields: a file written before the keys were consolidated can hold two
    /// spellings of one program, and a removal that cleaned only one would
    /// leave the other holding the rule — resurrecting the feed on the next
    /// launch and keeping the endpoint release from happening.
    fn remove_rule(&mut self, source_exe: &str, target_exe: &str) {
        let keys: Vec<String> = self
            .feeds
            .keys()
            .filter(|name| name.eq_ignore_ascii_case(source_exe))
            .cloned()
            .collect();
        for key in keys {
            if let Some(entry) = self.feeds.get_mut(&key) {
                entry.retain(|name| !name.eq_ignore_ascii_case(target_exe));
                if entry.is_empty() {
                    self.feeds.remove(&key);
                }
            }
        }
    }
}

/// Manages the feed memory file (interior mutability for Tauri State).
pub struct FeedConfig {
    inner: Mutex<FeedConfigInner>,
}

struct FeedConfigInner {
    path: PathBuf,
    map: FeedMap,
}

impl FeedConfig {
    /// Load config from the app data directory.
    pub fn load(app_handle: &AppHandle) -> Result<Self, String> {
        let path = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| format!("app_data_dir failed: {e}"))?
            .join("feed-memory.json");

        let mut map: FeedMap = read_or_default(&path);
        map.consolidate_case_variants();

        Ok(Self {
            inner: Mutex::new(FeedConfigInner { path, map }),
        })
    }

    /// Record that `source_exe`'s audio is sent into `target_exe`'s input.
    pub fn add(&self, source_exe: &str, target_exe: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.map.add_rule(source_exe, target_exe);
        inner.persist()
    }

    /// Drop one target from a source's rule; an empty rule removes the entry.
    pub fn remove(&self, source_exe: &str, target_exe: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.map.remove_rule(source_exe, target_exe);
        inner.persist()
    }

    /// Every rule as `(source_exe, target_exe)` pairs.
    pub fn all(&self) -> Vec<(String, String)> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner
            .map
            .feeds
            .iter()
            .flat_map(|(source, targets)| {
                targets
                    .iter()
                    .map(move |target| (source.clone(), target.clone()))
            })
            .collect()
    }

    /// Forget every feed rule — one half of the "start clean" the tour's
    /// inherit screen offers a machine walking in from an older release.
    pub fn clear(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.map.feeds.clear();
        inner.persist()
    }
}

impl FeedConfigInner {
    /// Persist to disk.
    fn persist(&self) -> Result<(), String> {
        persist_json(&self.path, &self.map)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_feed_rule_lands_under_the_spelling_already_on_file() {
        let mut map: FeedMap =
            serde_json::from_str(r#"{"feeds": {"Chrome.exe": ["obs64.exe"]}}"#).unwrap();
        // The same program arriving under another case must join the entry it
        // already has, not open a second one: two entries for one program is
        // how a remembered feed ends up read twice.
        map.add_rule("chrome.exe", "audacity.exe");
        assert_eq!(map.feeds.len(), 1, "one program, one entry");
        assert_eq!(
            map.feeds["Chrome.exe"],
            vec!["obs64.exe".to_string(), "audacity.exe".to_string()]
        );
    }

    #[test]
    fn a_feed_target_is_not_recorded_twice() {
        let mut map = FeedMap::default();
        map.add_rule("game.exe", "OBS64.exe");
        map.add_rule("game.exe", "obs64.exe");
        assert_eq!(map.feeds["game.exe"].len(), 1);
    }

    #[test]
    fn removing_a_feed_target_cleans_every_case_variant_of_the_source() {
        // A file written before the keys were consolidated can hold two
        // spellings of one program. A removal that cleaned only the first the
        // map happened to yield would leave the other holding the rule —
        // resurrecting the feed on the next launch and keeping the endpoint
        // release from happening.
        let mut map: FeedMap = serde_json::from_str(
            r#"{"feeds": {"Chrome.exe": ["obs64.exe"], "chrome.exe": ["obs64.exe", "audacity.exe"]}}"#,
        )
        .unwrap();
        map.remove_rule("chrome.exe", "obs64.exe");
        assert_eq!(map.feeds.len(), 1, "the emptied variant goes too");
        assert_eq!(map.feeds["chrome.exe"], vec!["audacity.exe".to_string()]);
    }

    #[test]
    fn one_program_with_two_spellings_on_file_keeps_every_feed_target() {
        // Folding the source's spelling may not cost the user a rule: the two
        // variants' targets merge, and a target the other spelling already lists
        // under another case is the same rule twice.
        let mut map: FeedMap = serde_json::from_str(
            r#"{"feeds": {"Chrome.exe": ["obs64.exe"], "chrome.exe": ["OBS64.EXE", "audacity.exe"]}}"#,
        )
        .unwrap();
        map.consolidate_case_variants();
        assert_eq!(map.feeds.len(), 1, "one source, one entry");
        assert!(!map.feeds.contains_key("chrome.exe"));
        assert_eq!(
            map.feeds["Chrome.exe"],
            vec!["obs64.exe".to_string(), "audacity.exe".to_string()]
        );
    }

    /// The feed fold is the one that can be lossless — every target of every
    /// spelling survives, whichever case it was written in — and it has to reach
    /// the same file whatever order it is handed the entries in, so a second load
    /// of its own output changes nothing.
    #[test]
    fn the_feed_fold_keeps_every_target_and_repeats_itself() {
        let mut map: FeedMap = serde_json::from_str(
            r#"{"feeds": {"Chrome.exe": ["obs64.exe"], "CHROME.EXE": [], "chrome.exe": ["audacity.exe", "OBS64.EXE"]}}"#,
        )
        .unwrap();
        map.consolidate_case_variants();
        assert_eq!(map.feeds.len(), 1, "three spellings, one source");
        let mut targets = map.feeds["CHROME.EXE"].clone();
        targets.sort();
        assert_eq!(
            targets,
            vec!["audacity.exe".to_string(), "obs64.exe".to_string()],
            "a target listed under two spellings is one rule, not two"
        );
        let json = serde_json::to_string(&map).unwrap();
        let mut again: FeedMap = serde_json::from_str(&json).unwrap();
        again.consolidate_case_variants();
        assert_eq!(serde_json::to_string(&again).unwrap(), json);
    }
}
