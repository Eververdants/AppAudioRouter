//! Route configuration persistence.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use log::warn;
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

/// Parse the contents of one config file, falling back to the default when they
/// are not this schema's JSON.
///
/// The fallback is deliberate: a config that cannot be read must not keep the
/// app from starting. What it must not be is *silent* — discarding every
/// remembered route or delay without a line anywhere is indistinguishable from
/// the feature being broken, and the difference matters because the file is
/// still on disk for the user to look at. A rename, a truncation or a hand
/// edit are all recoverable once someone knows which file to open.
fn parse_or_default<T>(path: &std::path::Path, content: &str) -> T
where
    T: Default + for<'de> Deserialize<'de>,
{
    match serde_json::from_str::<T>(content) {
        Ok(map) => map,
        Err(e) => {
            warn!(
                "config {} does not parse ({e}); falling back to defaults and leaving the file as it is",
                path.display()
            );
            T::default()
        }
    }
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
            parse_or_default(&path, &content)
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

        let mut map = if path.exists() {
            let content =
                fs::read_to_string(&path).map_err(|e| format!("read config failed: {e}"))?;
            parse_or_default(&path, &content)
        } else {
            DelayMap::default()
        };
        // The file is user-editable and was written by older versions, and
        // neither is bound by what this build supports: a range past the
        // engine's ring capacity, or delays past the range it was sized for,
        // would load here as-is and leave the mirrors truncating audio. The
        // same clamp a range change applies pulls the whole file back into
        // what the engine was designed to hold.
        map.clamp_to_range(map.delay_range_ms);

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
            parse_or_default(&path, &content)
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

        let map = if path.exists() {
            let content =
                fs::read_to_string(&path).map_err(|e| format!("read config failed: {e}"))?;
            parse_or_default(&path, &content)
        } else {
            FeedMap::default()
        };

        Ok(Self {
            inner: Mutex::new(FeedConfigInner { path, map }),
        })
    }

    /// Record that `source_exe`'s audio is sent into `target_exe`'s input.
    pub fn add(&self, source_exe: &str, target_exe: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        let entry = inner.map.feeds.entry(source_exe.to_string()).or_default();
        if !entry
            .iter()
            .any(|name| name.eq_ignore_ascii_case(target_exe))
        {
            entry.push(target_exe.to_string());
        }
        inner.persist()
    }

    /// Drop one target from a source's rule; an empty rule removes the entry.
    pub fn remove(&self, source_exe: &str, target_exe: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        // The map is keyed by whatever spelling the rule was recorded under,
        // and an image name carries whatever case the launch used — match the
        // same way the reader does, or a removal silently does nothing.
        let key = inner
            .map
            .feeds
            .keys()
            .find(|name| name.eq_ignore_ascii_case(source_exe))
            .cloned();
        if let Some(key) = key {
            if let Some(entry) = inner.map.feeds.get_mut(&key) {
                entry.retain(|name| !name.eq_ignore_ascii_case(target_exe));
                if entry.is_empty() {
                    inner.map.feeds.remove(&key);
                }
            }
        }
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
}

impl FeedConfigInner {
    /// Persist to disk.
    fn persist(&self) -> Result<(), String> {
        persist_json(&self.path, &self.map)
    }
}

/// The loopback endpoint pair feeds are carried through.
///
/// Sending one program's audio into another's input needs a wire both ends can
/// address: the source is pointed at the pair's playback side and the target at
/// its recording side. Any loopback driver provides such a pair (a virtual
/// cable's input and output); this app does not ship one, so the pair is the
/// user's to pick. Either half missing means feeds are remembered but silent.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct FeedCarrier {
    #[serde(default)]
    pub render: Option<String>,
    #[serde(default)]
    pub capture: Option<String>,
}

/// Manages the feed carrier config file (interior mutability for Tauri State).
pub struct FeedCarrierConfig {
    inner: Mutex<FeedCarrierInner>,
}

struct FeedCarrierInner {
    path: PathBuf,
    carrier: FeedCarrier,
}

impl FeedCarrierConfig {
    /// Load config from the app data directory.
    pub fn load(app_handle: &AppHandle) -> Result<Self, String> {
        let path = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| format!("app_data_dir failed: {e}"))?
            .join("feed-carrier.json");

        let carrier = if path.exists() {
            let content =
                fs::read_to_string(&path).map_err(|e| format!("read config failed: {e}"))?;
            parse_or_default(&path, &content)
        } else {
            FeedCarrier::default()
        };

        Ok(Self {
            inner: Mutex::new(FeedCarrierInner { path, carrier }),
        })
    }

    /// The configured pair, both halves possibly `None`.
    pub fn get(&self) -> FeedCarrier {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .carrier
            .clone()
    }

    /// Replace the pair and persist it.
    pub fn set(&self, render: Option<String>, capture: Option<String>) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.carrier = FeedCarrier { render, capture };
        inner.persist()
    }
}

impl FeedCarrierInner {
    /// Persist to disk.
    fn persist(&self) -> Result<(), String> {
        persist_json(&self.path, &self.carrier)
    }
}

/// Ceiling for a program's own level, as a percentage of what that program
/// produced.
///
/// A *device* volume may only attenuate, because a device has a hardware volume
/// above the software one that can be turned up. A program's audio has nothing
/// above it, so raising a quiet program to its neighbours means amplifying it —
/// the one thing this file allows that `device-volumes.json` does not. The
/// ceiling is what stops that being a blank cheque: past roughly +12 dB a
/// program's noise floor comes up along with its signal.
pub const SOURCE_VOLUME_MAX: u32 = 400;

/// The level at which a program's audio is left exactly as the program produced
/// it. Never persisted, so clearing a value round-trips back to the same neutral
/// number the frontend assumes.
pub const SOURCE_VOLUME_NEUTRAL: u32 = 100;

/// Per-program levels, keyed by executable name.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct SourceVolumeMap {
    #[serde(default)]
    volumes: HashMap<String, u32>,
}

impl SourceVolumeMap {
    /// The level for `exe_name`, neutral when nothing is stored.
    pub fn level(&self, exe_name: &str) -> u32 {
        self.volumes
            .get(exe_name)
            .copied()
            .unwrap_or(SOURCE_VOLUME_NEUTRAL)
    }

    /// Store one program's level, or clear it when it is the neutral value.
    pub fn store(&mut self, exe_name: &str, percent: u32) -> Result<(), String> {
        if percent > SOURCE_VOLUME_MAX {
            return Err(format!(
                "source volume {percent} is out of range (0–{SOURCE_VOLUME_MAX})"
            ));
        }
        if percent == SOURCE_VOLUME_NEUTRAL {
            // Unlike a device volume, the neutral value is not the top of the
            // range here, it is the middle of it: only equality means "as the
            // program made it", which is why this is not the `>=` the device
            // config uses.
            self.volumes.remove(exe_name);
        } else {
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

        let map = if path.exists() {
            let content =
                fs::read_to_string(&path).map_err(|e| format!("read config failed: {e}"))?;
            parse_or_default(&path, &content)
        } else {
            SourceVolumeMap::default()
        };

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
}

impl SourceVolumeConfigInner {
    /// Persist to disk.
    fn persist(&self) -> Result<(), String> {
        persist_json(&self.path, &self.map)
    }
}

/// Lower bound of a routed program's session volume, as a percent.
///
/// The session volume is the one lever that reaches the primary device's
/// loudness, and the engine compensates the copies by dividing their gain by
/// it — so it can never reach zero: at 0 the captured stream is true silence
/// and no gain can give the copies their loudness back. 5 % keeps that
/// compensation at ×20 and the "the copies are unaffected" promise honest all
/// the way down. The frontend's `PRIMARY_VOLUME_MIN` is the same literal; the
/// two are not bound together by anything but this note.
pub const PRIMARY_VOLUME_MIN_PERCENT: u32 = 5;

/// Per-program primary volumes, keyed by executable name.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct PrimaryVolumeMap {
    #[serde(default)]
    volumes: HashMap<String, u32>,
}

impl PrimaryVolumeMap {
    /// The volume for `exe_name`, neutral when nothing is stored.
    pub fn volume(&self, exe_name: &str) -> u32 {
        self.volumes
            .get(exe_name)
            .copied()
            .unwrap_or(SOURCE_VOLUME_NEUTRAL)
    }

    /// Store one program's primary volume, or clear it at the neutral value.
    pub fn store(&mut self, exe_name: &str, percent: u32) -> Result<(), String> {
        if !(PRIMARY_VOLUME_MIN_PERCENT..=SOURCE_VOLUME_NEUTRAL).contains(&percent) {
            return Err(format!(
                "primary volume {percent} is out of range ({PRIMARY_VOLUME_MIN_PERCENT}–{SOURCE_VOLUME_NEUTRAL})"
            ));
        }
        if percent == SOURCE_VOLUME_NEUTRAL {
            self.volumes.remove(exe_name);
        } else {
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

        let map = if path.exists() {
            let content =
                fs::read_to_string(&path).map_err(|e| format!("read config failed: {e}"))?;
            parse_or_default(&path, &content)
        } else {
            PrimaryVolumeMap::default()
        };

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

/// Window and shell behaviour the **native** side has to know about.
///
/// Theme, language and delay step are pure webview preferences and stay in
/// localStorage. These are read while handling a window event or writing the
/// startup registry key — possibly with no webview involved at all — so they
/// belong with the other backend settings.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct SettingsMap {
    /// Whether the close button hides the window to the tray instead of quitting.
    ///
    /// Off by default, which keeps the behaviour every version up to 2.1 had:
    /// closing the window takes the running duplications down with it.
    #[serde(default)]
    close_to_tray: bool,
}

/// Manages the shell settings file (interior mutability for Tauri State).
pub struct AppSettings {
    inner: Mutex<AppSettingsInner>,
}

struct AppSettingsInner {
    path: PathBuf,
    map: SettingsMap,
}

impl AppSettings {
    /// Load config from the app data directory.
    pub fn load(app_handle: &AppHandle) -> Result<Self, String> {
        let path = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| format!("app_data_dir failed: {e}"))?
            .join("app-settings.json");

        let map = if path.exists() {
            let content =
                fs::read_to_string(&path).map_err(|e| format!("read config failed: {e}"))?;
            parse_or_default(&path, &content)
        } else {
            SettingsMap::default()
        };

        Ok(Self {
            inner: Mutex::new(AppSettingsInner { path, map }),
        })
    }

    /// Whether closing the window should hide it to the tray.
    pub fn close_to_tray(&self) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .map
            .close_to_tray
    }

    /// Set and persist the close-to-tray preference.
    pub fn set_close_to_tray(&self, enabled: bool) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|e| e.to_string())?;
        inner.map.close_to_tray = enabled;
        inner.persist()
    }
}

impl AppSettingsInner {
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
pub(crate) fn persist_json<T: Serialize>(path: &std::path::Path, value: &T) -> Result<(), String> {
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
    fn an_unparsable_config_falls_back_to_the_default() {
        // The half that can be asserted here is the fallback: a truncated or
        // hand-edited file must not stop the app from starting. The other half
        // — that it says so — is the warning `parse_or_default` logs.
        let path = std::path::Path::new("route-memory.json");
        let map: RouteMap = parse_or_default(path, "{\"routes\": ");
        assert!(map.routes.is_empty());
    }

    #[test]
    fn a_schema_mismatch_falls_back_rather_than_partially_loading() {
        // A file of the right shape but the wrong types is the likeliest real
        // case: a delay written as a string, a volume as a float. Half of it
        // loading would leave the app running on numbers nobody chose.
        let path = std::path::Path::new("device-delays.json");
        let map: DelayMap = parse_or_default(path, r#"{"delays": {"dev": "soon"}}"#);
        assert!(map.delays.is_empty());
        assert_eq!(map.delay_range_ms, DELAY_RANGE_DEFAULT_MS);
    }

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

    #[test]
    fn shell_settings_default_to_quitting_on_close() {
        // A missing key — every config written before the tray existed — must not
        // change what the close button used to do.
        let map: SettingsMap = serde_json::from_str("{}").unwrap();
        assert!(!map.close_to_tray);
        let map: SettingsMap = serde_json::from_str(r#"{"close_to_tray":true}"#).unwrap();
        assert!(map.close_to_tray);
    }
}
