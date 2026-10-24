//! The loopback endpoint pair feeds are carried through.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::file_io::{persist_json, read_or_default};

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

        let carrier = read_or_default(&path);

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
