//! Per-device delay compensation: device id -> signed milliseconds.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::file_io::{persist_json, read_or_default};
use super::DELAY_MAX_MS;

/// Per-device delay compensation store: device_id -> milliseconds (signed).
///
/// Used to align a fast device (e.g. wired speakers) with a slow one (e.g. a
/// Bluetooth headset whose codec adds inherent hardware latency). Only mirrors
/// (duplicated devices) can be compensated — the primary device is played by
/// the OS directly.
///
/// A positive value holds that mirror back; a negative value marks it as the
/// earliest device of the group, which lifts every *other* mirror by the same
/// amount instead (software delay can only add latency, never remove it).
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct DelayMap {
    #[serde(default)]
    pub(super) delays: HashMap<String, i32>,
}

/// Manages the delay config file (interior mutability for Tauri State).
pub struct DelayConfig {
    inner: Mutex<DelayConfigInner>,
}

struct DelayConfigInner {
    path: PathBuf,
    map: DelayMap,
}

impl DelayMap {
    /// Pull every stored value into the supported bounds: ones past the hard
    /// ceiling are clamped to it, and ones clamped to 0 are dropped.
    ///
    /// The file is user-editable and was written by older versions, and neither
    /// is bound by what this build supports: a delay past the engine's ring
    /// capacity would load here as-is and leave the mirrors truncating audio.
    fn sanitize(&mut self) {
        for delay in self.delays.values_mut() {
            *delay = (*delay).clamp(-DELAY_MAX_MS, DELAY_MAX_MS);
        }
        self.delays.retain(|_, delay| *delay != 0);
    }

    /// Store one device's delay, or — when it is 0 — make sure it is not stored.
    ///
    /// A zero delay is an absence, not a value. It is exactly what [`DelayMap::
    /// sanitize`] drops on the way in and what `get` answers for a device with no
    /// entry, so an entry that *holds* a 0 would be listed back to the frontend as
    /// a device somebody customised — a row in the settings page and a compensation
    /// the engine cannot apply, for a number that changes nothing. Same shape as
    /// the neutral source level, which is cleared rather than written.
    ///
    /// Past the hard ceiling the value is refused, not clamped: the caller is
    /// expected to stay inside the rail, and a silent clamp would leave the two
    /// sides disagreeing about the applied value. A refusal touches nothing.
    fn store(&mut self, device_id: &str, delay_ms: i32) -> Result<(), String> {
        if delay_ms.abs() > DELAY_MAX_MS {
            return Err(format!(
                "delay {delay_ms} ms is outside the supported ±{DELAY_MAX_MS} ms bound"
            ));
        }
        if delay_ms == 0 {
            self.delays.remove(device_id);
        } else {
            self.delays.insert(device_id.to_string(), delay_ms);
        }
        Ok(())
    }
}

impl DelayConfig {
    /// Load config from the app data directory.
    pub fn load(app_handle: &AppHandle) -> Result<Self, String> {
        let path = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| format!("app_data_dir failed: {e}"))?
            .join("device-delays.json");

        let mut map: DelayMap = read_or_default(&path);
        map.sanitize();

        Ok(Self {
            inner: Mutex::new(DelayConfigInner { path, map }),
        })
    }

    /// Get one device's delay in milliseconds (0 when unset).
    pub fn get(&self, device_id: &str) -> i32 {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .map
            .delays
            .get(device_id)
            .copied()
            .unwrap_or(0)
    }

    /// Set one device's delay and persist. 0 removes the entry.
    ///
    /// The rule lives in [`DelayMap::store`], so the write path and the load path
    /// cannot disagree about whether a zero delay is a stored thing at all.
    pub fn set(&self, device_id: &str, delay_ms: i32) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.map.store(device_id, delay_ms)?;
        inner.persist()
    }

    /// All entries as `(device_id, delay_ms)` pairs.
    pub fn all(&self) -> Vec<(String, i32)> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner
            .map
            .delays
            .iter()
            .map(|(k, v)| (k.clone(), *v))
            .collect()
    }

    /// Forget every delay — the "start clean" the tour's inherit screen offers
    /// a machine walking in from an older release.
    pub fn clear(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.map.delays.clear();
        inner.persist()
    }
}

impl DelayConfigInner {
    /// Persist to disk.
    fn persist(&self) -> Result<(), String> {
        persist_json(&self.path, &self.map)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delay_config_loads_unsigned_values_written_before_signed_delays() {
        let map: DelayMap = serde_json::from_str(r#"{"delays": {"dev": 300}}"#).unwrap();
        assert_eq!(map.delays["dev"], 300);
    }

    #[test]
    fn delay_config_ignores_the_range_key_older_versions_wrote() {
        // The configurable range is gone; a file still carrying its key loads
        // the values and drops the key on the next write.
        let map: DelayMap =
            serde_json::from_str(r#"{"delays":{"early":-1000,"late":2000},"delay_range_ms":3000}"#)
                .unwrap();
        assert_eq!(map.delays["early"], -1000);
        assert_eq!(map.delays["late"], 2000);
    }

    #[test]
    fn sanitizing_clamps_delays_past_the_hard_bound_and_drops_zeros() {
        let mut map = DelayMap {
            delays: HashMap::from([
                ("big".to_string(), 60_000),
                ("negative".to_string(), -20_000),
                ("small".to_string(), -500),
                ("zero".to_string(), 0),
            ]),
        };
        map.sanitize();
        assert_eq!(map.delays["big"], DELAY_MAX_MS);
        assert_eq!(map.delays["negative"], -DELAY_MAX_MS);
        // Already inside the bound: untouched.
        assert_eq!(map.delays["small"], -500);
        assert!(!map.delays.contains_key("zero"));
    }

    /// The other half of the same rule, on the way *in* rather than on the way
    /// out: a zero delay is an absence, so writing one over a value the user set is
    /// how a device goes back to the number it was measured with — and it goes back
    /// by leaving the file, not by holding a 0 that `get` and `all` would have to
    /// explain. A stored 0 listed back is a settings row that reads as customised
    /// with nothing customised, the same lie the neutral source level refuses.
    #[test]
    fn a_zero_delay_is_an_absence_at_both_ends_of_the_round_trip() {
        let mut map = DelayMap::default();
        map.store("tuned", 180).unwrap();
        assert_eq!(map.delays["tuned"], 180);
        map.store("untouched", 0).unwrap();
        assert!(
            !map.delays.contains_key("untouched"),
            "writing the neutral value stores nothing"
        );
        map.store("tuned", 0).unwrap();
        assert!(
            !map.delays.contains_key("tuned"),
            "and it takes a value that was there away with it"
        );

        // Past the rail: refused, and the map is left holding what it held.
        assert!(map.store("big", DELAY_MAX_MS + 1).is_err());
        assert!(map.store("big", -DELAY_MAX_MS - 1).is_err());
        assert!(!map.delays.contains_key("big"), "a refusal stores nothing");
        // The bound itself is writable.
        map.store("edge", DELAY_MAX_MS).unwrap();

        // The published file says the same thing as the map: what a later load
        // reads back is a device with no entry, not a device with a 0.
        let json = serde_json::to_string(&map).unwrap();
        let mut back: DelayMap = serde_json::from_str(&json).unwrap();
        back.sanitize();
        assert_eq!(back.delays.get("tuned"), None);
        assert_eq!(back.delays.get("untouched"), None);
        assert_eq!(back.delays.get("big"), None);
        assert_eq!(back.delays["edge"], DELAY_MAX_MS);
    }
}
