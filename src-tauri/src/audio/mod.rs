//! Audio core module.
//!
//! Provides Windows Core Audio API abstractions for:
//! - Device enumeration (IMMDeviceEnumerator)
//! - Session enumeration (IAudioSessionEnumerator)
//! - Per-app default device routing (IPolicyConfigVista)

pub mod devices;
pub mod duplication;
pub mod notifications;
pub mod routing;
pub mod sessions;

use serde::Serialize;
use thiserror::Error;
use windows::core::PWSTR;
use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

/// Errors that can originate from the audio module.
#[derive(Debug, Error)]
pub enum AudioError {
    /// COM initialization failed on the calling thread.
    #[error("CoInitializeEx failed: 0x{0:08X}")]
    ComInit(i32),

    /// A Windows Core Audio API call returned a failure HRESULT.
    #[error("{0}")]
    Api(String),
}

/// Initialize COM on the calling thread for the duration of a command.
///
/// Audio work runs on threads this project owns — `spawn_blocking` workers for
/// the enumeration and routing commands, the notification thread, one capture
/// and one render thread per engine — so the multithreaded apartment is usually
/// free and we get it. The request can still fail with `RPC_E_CHANGED_MODE` on
/// an apartment initialized by someone else (Tauri runs sync commands on the
/// WebView2 STA main thread); the apartment is already usable, so reuse it.
///
/// Returns `true` when the caller must balance with `CoUninitialize()`.
pub fn init_com() -> Result<bool, AudioError> {
    // SAFETY: Thread-local COM init; balanced with CoUninitialize when we own it.
    let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    if hr.is_ok() {
        // S_OK and S_FALSE both require a balancing CoUninitialize.
        Ok(true)
    } else if hr == RPC_E_CHANGED_MODE {
        // Already initialized on this thread with a different model; valid to use.
        Ok(false)
    } else {
        Err(AudioError::ComInit(hr.0))
    }
}

/// Balance a successful [`init_com`] call.
pub fn uninit_com(owned: bool) {
    if owned {
        // SAFETY: Balances a successful CoInitializeEx from init_com.
        unsafe { CoUninitialize() };
    }
}

/// Copy a COM-allocated `PWSTR` into an owned `String`.
///
/// The caller still owns the allocation and must free it with `CoTaskMemFree`.
pub fn pwstr_to_string(pwstr: &PWSTR) -> String {
    if pwstr.is_null() {
        return String::new();
    }
    // SAFETY: a PWSTR from COM is a valid NUL-terminated wide string.
    unsafe {
        let mut len = 0;
        let mut ptr = pwstr.0;
        while *ptr != 0 {
            len += 1;
            ptr = ptr.add(1);
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(pwstr.0, len))
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
}

/// Role for default endpoint selection.
#[derive(Debug, Clone, Copy, Default)]
pub enum Role {
    /// Applies to all roles (console + multimedia + communications).
    #[default]
    All,
    /// Games, system sounds, and other non-media audio.
    Console,
    /// Music, video, and other media playback.
    Multimedia,
    /// Voice chat, phone calls, and other communications.
    Communications,
}
