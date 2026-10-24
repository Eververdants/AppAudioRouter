//! Device shares: device id -> percent (the loudness of a mirror's copy).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::file_io::{persist_json, read_or_default};

/// Per-device volume store: device_id -> percent (0–100).
///
/// The value is a device's share of the group's loudest device: a mirror is
/// scaled by `own / max`, so 100 means "play at the level the app asked for"
/// and is not persisted. Software gain can only attenuate, which is why the
/// loudest device is the reference the rest are measured against — the same
/// shape as delays, where the earliest device is the reference.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct VolumeMap {
    #[serde(default)]
    volumes: HashMap<String, u32>,
}

impl VolumeMap {
    /// Pull every stored share into the range this build allows.
    ///
    /// Same reason the delays, the source levels and the primary volumes are
    /// clamped on the way in: the file is user-editable and was written by
    /// older versions, and neither is bound by what the app here assumes. A
    /// share of 250 would become the group's reference — every other device
    /// scaled against a number no UI ever produced, and the one device it came
    /// from the copy that can never be attenuated. 100 is the unset neutral
    /// (`set` never stores it), so a clamped-to-neutral entry is dropped; 0 is
    /// a legitimate stored value — mute — and stays.
    fn clamp_to_range(&mut self) {
        for share in self.volumes.values_mut() {
            *share = (*share).min(100);
        }
        self.volumes.retain(|_, share| *share != 100);
    }
}

/// Manages the per-device volume config file (interior mutability for Tauri State).
pub struct VolumeConfig {
    inner: Mutex<VolumeConfigInner>,
}

struct VolumeConfigInner {
    path: PathBuf,
    map: VolumeMap,
}

impl VolumeConfig {
    /// Load config from the app data directory.
    pub fn load(app_handle: &AppHandle) -> Result<Self, String> {
        let path = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| format!("app_data_dir failed: {e}"))?
            .join("device-volumes.json");

        let mut map: VolumeMap = read_or_default(&path);
        map.clamp_to_range();

        Ok(Self {
            inner: Mutex::new(VolumeConfigInner { path, map }),
        })
    }

    /// Get one device's volume in percent (100 when unset).
    pub fn get(&self, device_id: &str) -> u32 {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .map
            .volumes
            .get(device_id)
            .copied()
            .unwrap_or(100)
    }

    /// Set one device's volume (0–100) and persist. 100 removes the entry.
    pub fn set(&self, device_id: &str, percent: u32) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if percent >= 100 {
            // The default (100 %) is not stored, so a reset round-trips back to
            // the same neutral value the frontend assumes. Clamping here would
            // make 100 collapse to 99 and the two sides would disagree forever.
            inner.map.volumes.remove(device_id);
        } else {
            inner.map.volumes.insert(device_id.to_string(), percent);
        }
        inner.persist()
    }

    /// All entries as `(device_id, percent)` pairs.
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

    /// Forget every share — the "start clean" the tour's inherit screen offers
    /// a machine walking in from an older release.
    pub fn clear(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.map.volumes.clear();
        inner.persist()
    }
}

impl VolumeConfigInner {
    /// Persist to disk.
    fn persist(&self) -> Result<(), String> {
        persist_json(&self.path, &self.map)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_device_volume_past_the_ceiling_does_not_reach_the_engine() {
        let mut map: VolumeMap =
            serde_json::from_str(r#"{"volumes": {"loud": 250, "muted": 0, "fine": 40}}"#).unwrap();
        map.clamp_to_range();
        // 250 clamps to the unset neutral, which is never stored: left alone it
        // would be the group's reference that no UI ever produced.
        assert!(!map.volumes.contains_key("loud"));
        // 0 is mute — a legitimate stored value.
        assert_eq!(map.volumes.get("muted"), Some(&0));
        assert_eq!(map.volumes.get("fine"), Some(&40));
    }
}
