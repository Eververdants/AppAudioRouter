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

/// Per-device delay compensation store: device_id -> milliseconds.
///
/// Used to align a fast device (e.g. wired speakers) with a slow one (e.g. a
/// Bluetooth headset whose codec adds inherent hardware latency). Only mirrors
/// (duplicated devices) can be delayed — the primary device is played by the
/// OS directly.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct DelayMap {
    #[serde(default)]
    delays: HashMap<String, u32>,
}

/// Manages the delay config file (interior mutability for Tauri State).
pub struct DelayConfig {
    inner: Mutex<DelayConfigInner>,
}

struct DelayConfigInner {
    path: PathBuf,
    map: DelayMap,
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
    pub fn get(&self, device_id: &str) -> u32 {
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
    pub fn set(&self, device_id: &str, delay_ms: u32) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if delay_ms == 0 {
            inner.map.delays.remove(device_id);
        } else {
            inner.map.delays.insert(device_id.to_string(), delay_ms);
        }
        inner.persist()
    }

    /// All entries as `(device_id, delay_ms)` pairs.
    pub fn all(&self) -> Vec<(String, u32)> {
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

/// Per-app volume limit store: exe_name -> percent (0–100).
///
/// A limit is applied as the app's audio-session master volume, so an app can
/// never play louder than the cap. 100 means "no limit" and is not persisted.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct VolumeMap {
    #[serde(default)]
    volumes: HashMap<String, u32>,
}

/// Manages the volume-limit config file (interior mutability for Tauri State).
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
            .join("session-volumes.json");

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

    /// Get one app's volume limit in percent (100 when unset).
    pub fn get(&self, exe_name: &str) -> u32 {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .map
            .volumes
            .get(exe_name)
            .copied()
            .unwrap_or(100)
    }

    /// Set one app's volume limit (0–100) and persist. 100 removes the entry.
    pub fn set(&self, exe_name: &str, percent: u32) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if percent >= 100 {
            inner.map.volumes.remove(exe_name);
        } else {
            inner
                .map
                .volumes
                .insert(exe_name.to_string(), percent.min(99));
        }
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

impl VolumeConfigInner {
    /// Persist to disk.
    fn persist(&self) -> Result<(), String> {
        persist_json(&self.path, &self.map)
    }
}

/// Serialize `value` as pretty JSON and write it to `path`, creating parent
/// directories as needed.
fn persist_json<T: Serialize>(path: &std::path::Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create_dir_all failed: {e}"))?;
    }
    let content =
        serde_json::to_string_pretty(value).map_err(|e| format!("serialize failed: {e}"))?;
    fs::write(path, content).map_err(|e| format!("write config failed: {e}"))?;
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
}
