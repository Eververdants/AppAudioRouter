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
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create_dir_all failed: {e}"))?;
        }
        let content = serde_json::to_string_pretty(&self.map)
            .map_err(|e| format!("serialize failed: {e}"))?;
        fs::write(&self.path, content).map_err(|e| format!("write config failed: {e}"))?;
        Ok(())
    }
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
