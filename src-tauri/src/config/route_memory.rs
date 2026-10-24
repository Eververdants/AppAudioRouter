//! Remembered routes: exe name -> the ordered device ids its audio goes to.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use log::warn;
use serde::{Deserialize, Deserializer, Serialize};
use tauri::{AppHandle, Manager};

use super::file_io::{persist_json, read_or_default};

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
    pub(super) routes: HashMap<String, DeviceList>,
}

impl RouteMap {
    /// Fold every case variant of one executable into the single entry that
    /// executable is allowed to have.
    ///
    /// `save_route` and `remove_route` consolidate as they write, but a file
    /// written before they did can still hold one program twice, and nothing
    /// there rewrites the spelling nobody touches again: every remembered route
    /// the settings page lists and every one the frontend restores would be read
    /// twice — two remembered routes for one program is how it ends up applied to
    /// two of a browser's processes, against the one-executable-one-process rule.
    /// The fold therefore happens on the way in rather than on the next write.
    ///
    /// The surviving spelling is the one that sorts first, so a fold does not
    /// depend on the map's iteration order; its targets are the first non-empty
    /// list remembered under any of the variants.
    ///
    /// Two spellings that remember *different* devices cannot both survive: one
    /// executable has one remembered route, and the head of a device list is its
    /// primary output, so gluing two lists together would invent a route with a
    /// primary nobody chose. The first sort keeps its own and the other is
    /// dropped — but a route the user set is not something to drop quietly, so
    /// every dropped list comes back in the return value for the caller to name
    /// in the log. Empty lists are never reported: forgetting is a state, not a
    /// lost route.
    fn consolidate_case_variants(&mut self) -> Vec<(String, Vec<String>)> {
        let mut names: Vec<String> = self.routes.keys().cloned().collect();
        names.sort();
        let mut folded: Vec<(String, DeviceList)> = Vec::new();
        let mut seen: HashMap<String, usize> = HashMap::new();
        let mut dropped: Vec<(String, Vec<String>)> = Vec::new();
        for name in names {
            let Some(list) = self.routes.remove(&name) else {
                continue;
            };
            match seen.get(&name.to_ascii_lowercase()).copied() {
                Some(index) => {
                    // A later variant only supplies targets when the spelling
                    // that survived remembered none: an empty list is no route.
                    if folded[index].1 .0.is_empty() {
                        if !list.0.is_empty() {
                            folded[index].1 = list;
                        }
                    } else if !list.0.is_empty() {
                        dropped.push((name, list.0));
                    }
                }
                None => {
                    seen.insert(name.to_ascii_lowercase(), folded.len());
                    folded.push((name, list));
                }
            }
        }
        self.routes = folded.into_iter().collect();
        dropped
    }
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

        let mut map: RouteMap = read_or_default(&path);
        // One program, one remembered route — and a route this fold had to give
        // up is the user's work, so it is named rather than silently lost. The
        // file on disk keeps both spellings until something writes either of
        // them, so this line is the only trace a user has of where the route they
        // set went.
        for (spelling, devices) in map.consolidate_case_variants() {
            warn!(
                "route memory holds {spelling} a second time with different devices \
                 ({devices:?}); one executable can keep only one remembered route, so \
                 this one was dropped and the spelling that sorts first was kept"
            );
        }

        Ok(Self {
            inner: Mutex::new(RouteConfigInner { path, map }),
        })
    }

    /// Save an app's ordered route targets.
    pub fn save_route(&self, exe_name: &str, device_ids: &[String]) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        // Drop any stored key that differs only in case before inserting, so one
        // executable holds exactly one entry. Two entries for one program is how
        // a remembered route ends up applied to two of a browser's processes.
        inner.retain_routes_except(exe_name);
        inner
            .map
            .routes
            .insert(exe_name.to_string(), DeviceList(device_ids.to_vec()));
        inner.persist()
    }

    /// Remove a route mapping.
    pub fn remove_route(&self, exe_name: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        if !inner.retain_routes_except(exe_name) {
            // Nothing was stored under this name in any case, so there is
            // nothing to write: the file already says what it should, and the
            // answer the caller gets is the same either way.
            return Ok(());
        }
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

    /// Forget every remembered route — one half of the "start clean" the tour's
    /// inherit screen offers a machine walking in from an older release.
    pub fn clear(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.map.routes.clear();
        inner.persist()
    }
}

impl RouteConfigInner {
    /// Drop every stored key that names `exe_name`, whatever its case, and
    /// report whether anything went.
    ///
    /// The stored key is the name Windows has for the file as this run happened
    /// to see it, so the same program can arrive once as `Chrome.exe` and once
    /// as `chrome.exe`. Matched exactly, "forget this route" would answer
    /// success, drop nothing, and put the route back on the next launch — and a
    /// second entry for one executable is how a remembered route ends up applied
    /// to two of a browser's processes.
    fn retain_routes_except(&mut self, exe_name: &str) -> bool {
        let before = self.map.routes.len();
        self.map
            .routes
            .retain(|stored, _| !stored.eq_ignore_ascii_case(exe_name));
        self.map.routes.len() != before
    }

    /// Persist to disk.
    fn persist(&self) -> Result<(), String> {
        persist_json(&self.path, &self.map)
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

    /// The routes still on the book, sorted, so two folds can be compared
    /// whatever order the map happens to iterate in.
    fn listed_routes(map: &RouteMap) -> Vec<(String, Vec<String>)> {
        let mut listed: Vec<(String, Vec<String>)> = map
            .routes
            .iter()
            .map(|(name, list)| (name.clone(), list.0.clone()))
            .collect();
        listed.sort();
        listed
    }

    #[test]
    fn one_program_with_two_spellings_on_file_keeps_one_route() {
        let mut map: RouteMap = serde_json::from_str(
            r#"{"routes": {"Chrome.exe": ["{0.0.0.00000000}.{a}"], "chrome.exe": ["{0.0.0.00000000}.{b}"], "game.exe": []}}"#,
        )
        .unwrap();
        let dropped = map.consolidate_case_variants();
        assert_eq!(map.routes.len(), 2, "one program, one entry");
        assert!(!map.routes.contains_key("chrome.exe"));
        assert_eq!(
            map.routes["Chrome.exe"].0,
            vec!["{0.0.0.00000000}.{a}".to_string()],
            "the spelling that sorts first survives with its own targets"
        );
        // And the route that had to go is handed to the caller to name in the
        // log, because "the memory folded them together" is not the same as
        // "the memory lost one on the floor".
        assert_eq!(
            dropped,
            vec![(
                "chrome.exe".to_string(),
                vec!["{0.0.0.00000000}.{b}".to_string()]
            )]
        );
        // A survivor that remembered nothing is no route to keep: the variant
        // behind it has the targets the user set.
        let mut map: RouteMap =
            serde_json::from_str(r#"{"routes": {"A.exe": [], "a.exe": ["device"]}}"#).unwrap();
        assert!(map.consolidate_case_variants().is_empty());
        assert_eq!(map.routes.len(), 1);
        assert_eq!(map.routes["A.exe"].0, vec!["device".to_string()]);
    }

    /// A fold that reports a lost route has to report only that: a variant whose
    /// devices merely filled the empty survivor is not a route the user lost, and
    /// folding the file the fold produced has to read the same way on the next
    /// start — a memory that changes shape each boot is not a memory.
    #[test]
    fn the_route_fold_reports_only_a_route_it_truly_lost_and_repeats_itself() {
        let mut map: RouteMap = serde_json::from_str(
            r#"{"routes": {"A.exe": [], "a.exe": ["device-1"], "B.exe": ["device-2"], "b.EXE": ["device-3"]}}"#,
        )
        .unwrap();
        let dropped = map.consolidate_case_variants();
        assert_eq!(
            dropped,
            vec![("b.EXE".to_string(), vec!["device-3".to_string()])],
            "a variant that only filled an empty survivor is no loss"
        );
        let first = listed_routes(&map);
        assert_eq!(
            first,
            vec![
                ("A.exe".to_string(), vec!["device-1".to_string()]),
                ("B.exe".to_string(), vec!["device-2".to_string()]),
            ]
        );
        let json = serde_json::to_string(&map).unwrap();
        let mut again: RouteMap = serde_json::from_str(&json).unwrap();
        assert!(
            again.consolidate_case_variants().is_empty(),
            "a folded file has nothing left to fold"
        );
        assert_eq!(listed_routes(&again), first);
    }
}
