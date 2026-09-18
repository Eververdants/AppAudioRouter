//! Route configuration persistence.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Deserializer, Serialize};
use tauri::{AppHandle, Manager};

/// Ordered list of route targets for one app.
///
/// The first id is the primary endpoint the OS assigns natively; any further
/// ids receive a duplicated copy of the stream (see `audio::duplication`).
///
/// Serialized transparently as an array of ids; also accepts a bare string so
/// configs written by v2.0 (single device) keep loading.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceList(#[serde(deserialize_with = "deserialize_device_list")] pub Vec<String>);

/// Deserializes one app's targets, accepting both the v2.0 single-device
/// string form and the current array form.
fn deserialize_device_list<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Raw {
        One(String),
        Many(Vec<String>),
    }

    Ok(match Raw::deserialize(deserializer)? {
        Raw::One(id) => vec![id],
        Raw::Many(ids) => ids,
    })
}

/// Persistent route memory: exe_name -> ordered target device ids.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct RouteMap {
    #[serde(default)]
    routes: HashMap<String, DeviceList>,
}

/// Manages route config file (interior mutability for Tauri State).
pub struct RouteConfig {
    inner: Mutex<RouteConfigInner>,
}

struct RouteConfigInner {
    path: PathBuf,
    map: RouteMap,
}

impl RouteConfig {
    /// Load config from the app data directory.
    pub fn load(app_handle: &AppHandle) -> Result<Self, String> {
        let path = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| format!("app_data_dir failed: {e}"))?
            .join("route-memory.json");

        let map = if path.exists() {
            let content =
                fs::read_to_string(&path).map_err(|e| format!("read config failed: {e}"))?;
            serde_json::from_str(&content).unwrap_or_default()
        } else {
            RouteMap::default()
        };

        Ok(Self {
            inner: Mutex::new(RouteConfigInner { path, map }),
        })
    }

    /// Save an app's ordered route targets.
    pub fn save_route(&self, exe_name: &str, device_ids: &[String]) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner
            .map
            .routes
            .insert(exe_name.to_string(), DeviceList(device_ids.to_vec()));
        inner.persist()
    }

    /// Remove a route mapping.
    pub fn remove_route(&self, exe_name: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.map.routes.remove(exe_name);
        inner.persist()
    }

    /// Get all routes as `(exe_name, device_ids)` pairs, ids in route order.
    pub fn get_all_routes(&self) -> Vec<(String, DeviceList)> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner
            .map
            .routes
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }
}

impl RouteConfigInner {
    /// Persist to disk.
    fn persist(&self) -> Result<(), String> {
        persist_json(&self.path, &self.map)
    }
}

/// Default half-range of the delay controls: the largest magnitude a delay may
/// be set to (±5 s).
pub const DELAY_RANGE_DEFAULT_MS: u32 = 5_000;
/// Lower bound of the configurable range — one step of the UI, so a smaller
/// range would leave nothing to adjust.
pub const DELAY_RANGE_MIN_MS: u32 = 1_000;
/// Upper bound of the configurable range. The duplication engine sizes its
/// ring buffers for the worst case it allows (largest positive delay plus the
/// largest group shift), so raising this costs memory per mirror.
pub const DELAY_RANGE_MAX_MS: u32 = 10_000;

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
#[derive(Debug, Serialize, Deserialize)]
pub struct DelayMap {
    #[serde(default)]
    delays: HashMap<String, i32>,
    /// Largest magnitude a delay may be set to, in milliseconds. Persisted next
    /// to the values so the engine and the UI agree on the same bound.
    #[serde(default = "default_delay_range_ms")]
    delay_range_ms: u32,
}

impl Default for DelayMap {
    fn default() -> Self {
        Self {
            delays: HashMap::new(),
            delay_range_ms: default_delay_range_ms(),
        }
    }
}

/// Serde default for [`DelayMap::delay_range_ms`], applied to configs written
/// before the range was configurable.
fn default_delay_range_ms() -> u32 {
    DELAY_RANGE_DEFAULT_MS
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
    /// Pull the range and every stored value into the supported bounds: values
    /// that no longer fit are clamped to the new bound, and ones clamped to 0
    /// are dropped.
    fn clamp_to_range(&mut self, range_ms: u32) {
        let range = range_ms.clamp(DELAY_RANGE_MIN_MS, DELAY_RANGE_MAX_MS) as i32;
        self.delay_range_ms = range as u32;
        for delay in self.delays.values_mut() {
            *delay = (*delay).clamp(-range, range);
        }
        self.delays.retain(|_, delay| *delay != 0);
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

        let map = if path.exists() {
            let content =
                fs::read_to_string(&path).map_err(|e| format!("read config failed: {e}"))?;
            serde_json::from_str(&content).unwrap_or_default()
        } else {
            DelayMap::default()
        };

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

    /// Largest magnitude a delay may be set to, in milliseconds.
    pub fn range_ms(&self) -> u32 {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .map
            .delay_range_ms
    }

    /// Set the delay range and pull every stored value into it, so the engine
    /// never applies a delay the UI is unable to show. `range_ms` is clamped to
    /// the supported bounds.
    pub fn set_range_ms(&self, range_ms: u32) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.map.clamp_to_range(range_ms);
        inner.persist()
    }

    /// Set one device's delay and persist. 0 removes the entry.
    ///
    /// A magnitude beyond the configured range is rejected rather than clamped:
    /// the caller (the UI) is expected to stay in range, and a silent clamp
    /// would leave the two sides disagreeing about the applied value.
    pub fn set(&self, device_id: &str, delay_ms: i32) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let range = inner.map.delay_range_ms as i64;
        if (delay_ms as i64).abs() > range {
            return Err(format!(
                "delay {delay_ms} ms is outside the configured ±{range} ms range"
            ));
        }
        if delay_ms == 0 {
            inner.map.delays.remove(device_id);
        } else {
            inner.map.delays.insert(device_id.to_string(), delay_ms);
        }
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
}

impl DelayConfigInner {
    /// Persist to disk.
    fn persist(&self) -> Result<(), String> {
        persist_json(&self.path, &self.map)
    }
}

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

        let map = if path.exists() {
            let content =
                fs::read_to_string(&path).map_err(|e| format!("read config failed: {e}"))?;
            serde_json::from_str(&content).unwrap_or_default()
        } else {
            VolumeMap::default()
        };

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
}

impl VolumeConfigInner {
    /// Persist to disk.
    fn persist(&self) -> Result<(), String> {
        persist_json(&self.path, &self.map)
    }
}

/// Serialize `value` as pretty JSON and write it to `path`, creating parent
/// directories as needed.
///
/// The write is atomic: the content lands in a same-directory `.tmp` file first,
/// then that file is renamed over the target. A crash mid-write can therefore
/// leave the stale `.tmp` behind, but never a half-written config — renaming
/// within one directory is atomic on all supported filesystems.
fn persist_json<T: Serialize>(path: &std::path::Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create_dir_all failed: {e}"))?;
    }
    let content =
        serde_json::to_string_pretty(value).map_err(|e| format!("serialize failed: {e}"))?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, content).map_err(|e| format!("write config failed: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| {
        // Best-effort cleanup of the temp file; the real error is the rename.
        let _ = fs::remove_file(&tmp);
        format!("commit config failed: {e}")
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_v2_single_device_string_format() {
        let map: RouteMap =
            serde_json::from_str(r#"{"routes": {"game.exe": "{0.0.0.00000000}.{a}"}}"#).unwrap();
        assert_eq!(
            map.routes["game.exe"].0,
            vec!["{0.0.0.00000000}.{a}".to_string()]
        );
    }

    #[test]
    fn loads_device_array_format() {
        let map: RouteMap = serde_json::from_str(
            r#"{"routes": {"game.exe": ["{0.0.0.00000000}.{a}", "{0.0.0.00000000}.{b}"]}}"#,
        )
        .unwrap();
        assert_eq!(
            map.routes["game.exe"].0,
            vec![
                "{0.0.0.00000000}.{a}".to_string(),
                "{0.0.0.00000000}.{b}".to_string()
            ]
        );
    }

    #[test]
    fn serializes_as_plain_array() {
        let map: RouteMap = serde_json::from_str(r#"{"routes": {"a.exe": ["x", "y"]}}"#).unwrap();
        let json = serde_json::to_string(&map).unwrap();
        assert_eq!(json, r#"{"routes":{"a.exe":["x","y"]}}"#);
    }

    #[test]
    fn delay_config_loads_unsigned_values_written_before_signed_delays() {
        let map: DelayMap = serde_json::from_str(r#"{"delays": {"dev": 300}}"#).unwrap();
        assert_eq!(map.delays["dev"], 300);
        // No range stored yet: the default applies.
        assert_eq!(map.delay_range_ms, DELAY_RANGE_DEFAULT_MS);
    }

    #[test]
    fn delay_config_roundtrips_signed_values() {
        let map: DelayMap =
            serde_json::from_str(r#"{"delays":{"early":-1000,"late":2000},"delay_range_ms":3000}"#)
                .unwrap();
        assert_eq!(map.delays["early"], -1000);
        assert_eq!(map.delays["late"], 2000);
        assert_eq!(map.delay_range_ms, 3000);
    }

    #[test]
    fn lowering_the_range_clamps_and_drops_delays() {
        let mut map = DelayMap {
            delays: HashMap::from([
                ("big".to_string(), 5_000),
                ("negative".to_string(), -4_000),
                ("small".to_string(), -500),
            ]),
            delay_range_ms: DELAY_RANGE_MAX_MS,
        };
        map.clamp_to_range(2_000);
        assert_eq!(map.delay_range_ms, 2_000);
        assert_eq!(map.delays["big"], 2_000);
        assert_eq!(map.delays["negative"], -2_000);
        // -500 is already inside ±2 s, so it survives untouched.
        assert_eq!(map.delays["small"], -500);
    }

    #[test]
    fn delay_range_is_clamped_to_the_supported_bounds() {
        let mut map = DelayMap::default();
        map.clamp_to_range(60_000);
        assert_eq!(map.delay_range_ms, DELAY_RANGE_MAX_MS);
        map.clamp_to_range(0);
        assert_eq!(map.delay_range_ms, DELAY_RANGE_MIN_MS);
    }
}
