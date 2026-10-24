//! Per-program levels: exe name -> percent of what that program produced.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::file_io::{persist_json, read_or_default};
use super::{SOURCE_VOLUME_MAX, SOURCE_VOLUME_NEUTRAL};

/// Per-program levels, keyed by executable name.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct SourceVolumeMap {
    #[serde(default)]
    volumes: HashMap<String, u32>,
}

impl SourceVolumeMap {
    /// Pull every stored level into the range this build allows.
    ///
    /// Same reason the delays are clamped on the way in: the file is user-editable
    /// and was written by older versions, and neither is bound by what the engine
    /// here can do with the number. A level of a million is a gain of ten thousand
    /// on the way to every routed device — the program's noise floor and its peaks
    /// amplified together into a wall of clipping — and one the frontend has never
    /// offered would sit there quietly destroying the audio until someone looked.
    fn clamp_to_range(&mut self) {
        for level in self.volumes.values_mut() {
            *level = (*level).min(SOURCE_VOLUME_MAX);
        }
        self.volumes
            .retain(|_, level| *level != SOURCE_VOLUME_NEUTRAL);
    }

    /// The level for `exe_name`, neutral when nothing is stored.
    ///
    /// Searched without regard to case, like every other exe-keyed map: a name
    /// carries whatever case the launch used, so the engine's spelling and the
    /// one on file are not guaranteed to match. Read by exact key, a stored 40
    /// would be missed and the program would play at the neutral level while
    /// the file said otherwise — and the settings page would still show the 40.
    pub fn level(&self, exe_name: &str) -> u32 {
        self.volumes
            .iter()
            .find(|(stored, _)| stored.eq_ignore_ascii_case(exe_name))
            .map(|(_, level)| *level)
            .unwrap_or(SOURCE_VOLUME_NEUTRAL)
    }

    /// Store one program's level, or clear it when it is the neutral value.
    pub fn store(&mut self, exe_name: &str, percent: u32) -> Result<(), String> {
        if percent > SOURCE_VOLUME_MAX {
            return Err(format!(
                "source volume {percent} is out of range (0–{SOURCE_VOLUME_MAX})"
            ));
        }
        // Every spelling of this program goes before the new entry arrives, so
        // one executable holds exactly one level: two entries for one program
        // leave the other one on file, reported to the settings page and read
        // by no engine.
        self.volumes
            .retain(|stored, _| !stored.eq_ignore_ascii_case(exe_name));
        // Unlike a device volume, the neutral value is not the top of the
        // range here, it is the middle of it: only equality means "as the
        // program made it", which is why this is not the `>=` the device
        // config uses. The retain above is that removal.
        if percent != SOURCE_VOLUME_NEUTRAL {
            self.volumes.insert(exe_name.to_string(), percent);
        }
        Ok(())
    }
}

/// Manages the per-program level file (interior mutability for Tauri State).
///
/// Keyed by **executable name, not PID**, for the same reason the routing
/// assignments are: a program can hold several audio sessions under several
/// PIDs, and the level belongs to the program.
pub struct SourceVolumeConfig {
    inner: Mutex<SourceVolumeConfigInner>,
}

struct SourceVolumeConfigInner {
    path: PathBuf,
    map: SourceVolumeMap,
}

impl SourceVolumeConfig {
    /// Load config from the app data directory.
    pub fn load(app_handle: &AppHandle) -> Result<Self, String> {
        let path = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| format!("app_data_dir failed: {e}"))?
            .join("source-volumes.json");

        let mut map: SourceVolumeMap = read_or_default(&path);
        map.clamp_to_range();

        Ok(Self {
            inner: Mutex::new(SourceVolumeConfigInner { path, map }),
        })
    }

    /// One program's level (neutral when unset).
    pub fn get(&self, exe_name: &str) -> u32 {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .map
            .level(exe_name)
    }

    /// Set one program's level and persist.
    pub fn set(&self, exe_name: &str, percent: u32) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.map.store(exe_name, percent)?;
        inner.persist()
    }

    /// All entries as `(exe_name, percent)` pairs.
    pub fn all(&self) -> Vec<(String, u32)> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .map
            .volumes
            .iter()
            .map(|(k, v)| (k.clone(), *v))
            .collect()
    }

    /// Forget every level — the "start clean" the tour's inherit screen offers
    /// a machine walking in from an older release.
    pub fn clear(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.map.volumes.clear();
        inner.persist()
    }
}

impl SourceVolumeConfigInner {
    /// Persist to disk.
    fn persist(&self) -> Result<(), String> {
        persist_json(&self.path, &self.map)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_source_level_roundtrips_above_neutral() {
        let mut map = SourceVolumeMap::default();
        map.store("quiet.exe", 250).unwrap();
        let json = serde_json::to_string(&map).unwrap();
        let back: SourceVolumeMap = serde_json::from_str(&json).unwrap();
        // The whole point of this file: a value above 100 has to survive the
        // round trip, because that is the only way a quiet program is brought
        // up to its neighbours.
        assert_eq!(back.level("quiet.exe"), 250);
    }

    #[test]
    fn a_source_level_falls_back_to_neutral_when_unset() {
        let map = SourceVolumeMap::default();
        assert_eq!(map.level("never-seen.exe"), SOURCE_VOLUME_NEUTRAL);
    }

    #[test]
    fn the_neutral_source_level_is_cleared_rather_than_stored() {
        let mut map = SourceVolumeMap::default();
        map.store("a.exe", 40).unwrap();
        assert_eq!(map.level("a.exe"), 40);
        map.store("a.exe", SOURCE_VOLUME_NEUTRAL).unwrap();
        // Cleared, not stored as 100: a reset has to come back to the same
        // shape as a program that was never touched.
        assert!(map.volumes.is_empty());
        // 100 is the middle of this range, so the rule is equality and not the
        // `>=` the attenuation-only device config uses.
        map.store("a.exe", 101).unwrap();
        assert_eq!(map.level("a.exe"), 101);
    }

    #[test]
    fn a_source_level_past_the_ceiling_is_refused() {
        let mut map = SourceVolumeMap::default();
        assert!(map.store("loud.exe", SOURCE_VOLUME_MAX + 1).is_err());
        assert!(map.store("loud.exe", SOURCE_VOLUME_MAX).is_ok());
        assert_eq!(map.level("loud.exe"), SOURCE_VOLUME_MAX);
    }

    #[test]
    fn a_source_level_is_read_and_stored_whatever_case_the_launch_used() {
        // The key is an image name, and the engine asks by the spelling its route
        // was made under while the file holds whatever case an earlier launch
        // used. Matched exactly, a stored 40 read as the neutral 100 and a fresh
        // write opened a second entry for one program.
        let mut map: SourceVolumeMap =
            serde_json::from_str(r#"{"volumes": {"Chrome.exe": 40}}"#).unwrap();
        assert_eq!(map.level("chrome.exe"), 40);
        map.store("chrome.exe", 250).unwrap();
        assert_eq!(map.volumes.len(), 1, "one program, one entry");
        assert_eq!(map.level("CHROME.EXE"), 250);
        // Clearing reaches the entry from any spelling too.
        map.store("Chrome.exe", SOURCE_VOLUME_NEUTRAL).unwrap();
        assert!(map.volumes.is_empty());
    }
}
