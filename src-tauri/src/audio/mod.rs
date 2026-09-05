//! Audio core module.
//!
//! Provides Windows Core Audio API abstractions for:
//! - Device enumeration (IMMDeviceEnumerator)
//! - Session enumeration (IAudioSessionEnumerator)
//! - Per-app default device routing (IPolicyConfigVista)

pub mod devices;
pub mod routing;
pub mod sessions;

use serde::Serialize;

/// Render (playback) device info returned to frontend.
#[derive(Debug, Clone, Serialize)]
pub struct AudioDevice {
    /// Endpoint ID string (used for routing commands).
    pub id: String,
    /// Human-readable device name.
    pub name: String,
}

/// Audio session (a process with an audio stream) returned to frontend.
#[derive(Debug, Clone, Serialize)]
pub struct AudioSession {
    /// Process ID.
    pub pid: u32,
    /// Executable name (e.g. `chrome.exe`).
    pub exe_name: String,
    /// Display name from audio session (often the window title or app name).
    pub display_name: String,
}

/// Role for default endpoint selection.
#[derive(Debug, Clone, Copy, Default)]
pub enum Role {
    #[default]
    All,
    Console,
    Multimedia,
    Communications,
}

impl Role {
    /// COM role value used by IPolicyConfig.
    pub fn as_str(&self) -> &'static str {
        match self {
            Role::All => "all",
            Role::Console => "console",
            Role::Multimedia => "multimedia",
            Role::Communications => "communications",
        }
    }
}
