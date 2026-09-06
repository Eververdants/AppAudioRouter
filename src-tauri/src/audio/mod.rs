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
use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

/// Initialize COM on the calling thread for the duration of a command.
///
/// Tauri runs sync commands on the main thread, which is already COM STA
/// (WebView2). Requesting COINIT_MULTITHREADED there fails with
/// RPC_E_CHANGED_MODE; the apartment is already initialized, so we reuse it.
///
/// Returns `true` when the caller must balance with `CoUninitialize()`.
pub fn init_com() -> Result<bool, String> {
    // SAFETY: Thread-local COM init; balanced with CoUninitialize when we own it.
    let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    if hr.is_ok() {
        // S_OK and S_FALSE both require a balancing CoUninitialize.
        Ok(true)
    } else if hr == RPC_E_CHANGED_MODE {
        // Already initialized on this thread with a different model; valid to use.
        Ok(false)
    } else {
        Err(format!("CoInitializeEx failed: 0x{:08X}", hr.0))
    }
}

/// Balance a successful [`init_com`] call.
pub fn uninit_com(owned: bool) {
    if owned {
        // SAFETY: Balances a successful CoInitializeEx from init_com.
        unsafe { CoUninitialize() };
    }
}

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
}
