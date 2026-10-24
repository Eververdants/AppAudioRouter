//! Per-program primary volumes: exe name -> session volume percent.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::file_io::{persist_json, read_or_default};
use super::{PRIMARY_VOLUME_MIN_PERCENT, SOURCE_VOLUME_NEUTRAL};

/// Per-program primary volumes, keyed by executable name.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct PrimaryVolumeMap {
    #[serde(default)]
    volumes: HashMap<String, u32>,
}

impl PrimaryVolumeMap {
    /// Pull every stored volume into the range this build allows.
    ///
    /// The floor is the one that matters: the session volume is what the capture
    /// stream is made of, so a stored 0 makes that stream true silence, and no
    /// gain on the copy side can give it back — the exact failure
    /// `PRIMARY_VOLUME_MIN_PERCENT` exists to prevent, arriving by way of a hand
    /// edit or an older build rather than the slider. Values above 100 are
    /// clamped down, because this axis can only ever take the program's own
    /// loudness away.
    fn clamp_to_range(&mut self) {
        for volume in self.volumes.values_mut() {
            *volume = (*volume).clamp(PRIMARY_VOLUME_MIN_PERCENT, SOURCE_VOLUME_NEUTRAL);
        }
        self.volumes
            .retain(|_, volume| *volume != SOURCE_VOLUME_NEUTRAL);
    }

    /// The volume for `exe_name`, neutral when nothing is stored.
    ///
    /// Searched without regard to case for the same reason the remembered routes
    /// are consolidated by it: the key is an image name, and a name carries
    /// whatever case the launch used. Read by exact key, an engine started under
    /// the other spelling claims the neutral 100 while the file says the program
    /// plays at 40 — and the read-back in `set_primary_volume` then hands the
    /// sessions a number the settings page does not show.
    pub fn volume(&self, exe_name: &str) -> u32 {
        self.volumes
            .iter()
            .find(|(stored, _)| stored.eq_ignore_ascii_case(exe_name))
            .map(|(_, volume)| *volume)
            .unwrap_or(SOURCE_VOLUME_NEUTRAL)
    }

    /// Store one program's primary volume, or clear it at the neutral value.
    pub fn store(&mut self, exe_name: &str, percent: u32) -> Result<(), String> {
        if !(PRIMARY_VOLUME_MIN_PERCENT..=SOURCE_VOLUME_NEUTRAL).contains(&percent) {
            return Err(format!(
                "primary volume {percent} is out of range ({PRIMARY_VOLUME_MIN_PERCENT}–{SOURCE_VOLUME_NEUTRAL})"
            ));
        }
        // One executable, one entry: a second spelling of the same program would
        // be read by no engine and listed as if it were another one.
        self.volumes
            .retain(|stored, _| !stored.eq_ignore_ascii_case(exe_name));
        // The neutral value is stored by removal, so a read-back that trusted the
        // entry alone would hand the sessions a 0.
        if percent != SOURCE_VOLUME_NEUTRAL {
            self.volumes.insert(exe_name.to_string(), percent);
        }
        Ok(())
    }
}

/// Manages the per-program primary volume file (interior mutability for Tauri
/// State).
///
/// Keyed by **executable name, not PID**, for the same reason the routing
/// assignments are: the session volume belongs to the program, and one program
/// can hold several sessions. It is the loudness of the program's *primary
/// path* — the endpoint Windows plays for it — and the engines running for
/// this program divide their mirrors' gain by the same factor, so the copies
/// are unaffected.
pub struct PrimaryVolumeConfig {
    inner: Mutex<PrimaryVolumeConfigInner>,
}

struct PrimaryVolumeConfigInner {
    path: PathBuf,
    map: PrimaryVolumeMap,
}

impl PrimaryVolumeConfig {
    /// Load config from the app data directory.
    pub fn load(app_handle: &AppHandle) -> Result<Self, String> {
        let path = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| format!("app_data_dir failed: {e}"))?
            .join("primary-volumes.json");

        let mut map: PrimaryVolumeMap = read_or_default(&path);
        map.clamp_to_range();

        Ok(Self {
            inner: Mutex::new(PrimaryVolumeConfigInner { path, map }),
        })
    }

    /// One program's primary volume (neutral when unset).
    pub fn get(&self, exe_name: &str) -> u32 {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .map
            .volume(exe_name)
    }

    /// Set one program's primary volume and persist.
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
}

impl PrimaryVolumeConfigInner {
    /// Persist to disk.
    fn persist(&self) -> Result<(), String> {
        persist_json(&self.path, &self.map)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_primary_volume_reads_back_the_number_the_program_plays_at() {
        // `set_primary_volume` reads this number back and hands it to the live
        // sessions instead of the percent its caller asked for: two clicks can
        // run there at once, and the lock — not the click order — decides which
        // write lands last. Every branch has to read back as the loudness that
        // actually took effect.
        let mut map = PrimaryVolumeMap::default();
        map.store("game.exe", 90).unwrap();
        assert_eq!(map.volume("game.exe"), 90);
        map.store("game.exe", PRIMARY_VOLUME_MIN_PERCENT).unwrap();
        assert_eq!(map.volume("game.exe"), PRIMARY_VOLUME_MIN_PERCENT);
        // The neutral value is stored *by removal*, so a read-back that trusted
        // the entry alone would hand the sessions a 0 and leave the program
        // muted on every path — the opposite of what a click on 100 means.
        map.store("game.exe", SOURCE_VOLUME_NEUTRAL).unwrap();
        assert!(map.volumes.is_empty());
        assert_eq!(map.volume("game.exe"), SOURCE_VOLUME_NEUTRAL);
    }

    #[test]
    fn a_primary_volume_is_read_and_stored_whatever_case_the_launch_used() {
        let mut map: PrimaryVolumeMap =
            serde_json::from_str(r#"{"volumes": {"Game.EXE": 40}}"#).unwrap();
        assert_eq!(map.volume("game.exe"), 40);
        map.store("game.exe", 70).unwrap();
        assert_eq!(map.volumes.len(), 1, "one program, one entry");
        assert_eq!(map.volume("Game.EXE"), 70);
        map.store("GAME.exe", SOURCE_VOLUME_NEUTRAL).unwrap();
        assert!(map.volumes.is_empty());
    }

    #[test]
    fn a_primary_volume_below_the_floor_is_refused_and_leaves_the_last_one() {
        // The floor exists because a session volume of 0 makes the captured
        // stream true silence. A refused write must leave the settled value
        // standing untouched: it is the number overlapping callers converge on,
        // and a half-applied one would be worse than either.
        let mut map = PrimaryVolumeMap::default();
        map.store("game.exe", 85).unwrap();
        assert!(map
            .store("game.exe", PRIMARY_VOLUME_MIN_PERCENT - 1)
            .is_err());
        assert_eq!(map.volume("game.exe"), 85);
        assert!(map.store("game.exe", SOURCE_VOLUME_NEUTRAL + 1).is_err());
        assert_eq!(map.volume("game.exe"), 85);
    }
}
