//! Route configuration persistence.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;

/// Persistent route memory: exe_name -> device_id.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct RouteMap {
    routes: HashMap<String, String>,
}

/// Manages route config file.
pub struct RouteConfig {
    path: PathBuf,
    map: RouteMap,
}

impl RouteConfig {
    /// Load config from the app data directory.
    pub fn load(app_handle: &tauri::AppHandle) -> Result<Self, String> {
        let path = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| format!("app_data_dir failed: {e}"))?
            .join("route-memory.json");

        let map = if path.exists() {
            let content = fs::read_to_string(&path)
                .map_err(|e| format!("read config failed: {e}"))?;
            serde_json::from_str(&content).unwrap_or_default()
        } else {
            RouteMap::default()
        };

        Ok(Self { path, map })
    }

    /// Save a route mapping.
    pub fn save_route(&mut self, exe_name: &str, device_id: &str) -> Result<(), String> {
        self.map
            .routes
            .insert(exe_name.to_string(), device_id.to_string());
        self.persist()
    }

    /// Remove a route mapping.
    pub fn remove_route(&mut self, exe_name: &str) -> Result<(), String> {
        self.map.routes.remove(exe_name);
        self.persist()
    }

    /// Get all routes.
    pub fn get_all_routes(&self) -> Vec<(String, String)> {
        self.map
            .routes
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    /// Get the device_id for an exe, if remembered.
    pub fn get_route(&self, exe_name: &str) -> Option<&String> {
        self.map.routes.get(exe_name)
    }

    /// Persist to disk.
    fn persist(&self) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("create_dir_all failed: {e}"))?;
        }
        let content = serde_json::to_string_pretty(&self.map)
            .map_err(|e| format!("serialize failed: {e}"))?;
        fs::write(&self.path, content)
            .map_err(|e| format!("write config failed: {e}"))?;
        Ok(())
    }
}
