//! Audio core module.
//!
//! Provides Windows Core Audio API abstractions for:
//! - Device enumeration (IMMDeviceEnumerator)
//! - Session enumeration (IAudioSessionEnumerator)
//! - Per-app default device routing (IPolicyConfigVista)

pub mod devices;
pub mod duplication;
pub mod levels;
pub mod notifications;
pub mod process_meta;
pub mod routing;
pub mod sessions;

use serde::Serialize;
use thiserror::Error;
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, RPC_E_CHANGED_MODE, STILL_ACTIVE};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{
    GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

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

/// The creation time of `pid`'s process, as a FILETIME, or `None` when the
/// process cannot be opened or queried. A process that has already died also
/// answers `None` here eventually, so a caller that records this as a witness
/// must pair it with [`process_is_running`] rather than compare it later.
pub(crate) fn process_creation_time(pid: u32) -> Option<u64> {
    // SAFETY: OpenProcess with QUERY_LIMITED_INFORMATION; the handle is closed
    // on both exits below, so a failed query does not leak it.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()? };
    let creation = creation_time_of(handle);
    // SAFETY: balances OpenProcess.
    unsafe {
        let _ = CloseHandle(handle);
    }
    creation
}

/// The creation time read from an already-open process handle, or `None` when
/// the query fails. The caller owns the handle.
fn creation_time_of(handle: HANDLE) -> Option<u64> {
    let mut creation = FILETIME::default();
    let mut _exit = FILETIME::default();
    let mut _kernel = FILETIME::default();
    let mut _user = FILETIME::default();
    // SAFETY: valid handle and out params.
    let read =
        unsafe { GetProcessTimes(handle, &mut creation, &mut _exit, &mut _kernel, &mut _user) }
            .is_ok();
    if !read {
        return None;
    }
    Some(((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64)
}

/// Whether `pid` still names a live process — and, when `recorded` carries a
/// creation time, the very same one that was running when the record was
/// written.
///
/// A process that has exited still opens while any handle to it survives, so
/// the exit has to be read from the exit code rather than assumed from the
/// open failing; a pid the kernel has since handed to a different process is
/// caught by the creation time. `recorded` of zero means no witness was
/// captured, and only the exit code is judged.
pub(crate) fn process_is_running(pid: u32, recorded: u64) -> bool {
    // SAFETY: OpenProcess with QUERY_LIMITED_INFORMATION; handle closed below.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) };
    let Ok(handle) = handle else {
        // The process was openable when the record was written, so a failed
        // open now means it is gone.
        return false;
    };
    let mut exit_code = 0u32;
    // SAFETY: h is a valid handle, exit_code is a live out parameter.
    let exited = unsafe { GetExitCodeProcess(handle, &mut exit_code) }.is_ok()
        && exit_code != STILL_ACTIVE.0 as u32;
    let same_process =
        creation_time_of(handle).is_none_or(|current| recorded == 0 || current == recorded);
    // SAFETY: balances OpenProcess.
    unsafe {
        let _ = CloseHandle(handle);
    }
    !exited && same_process
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
    /// How the process names itself to a person: its best window's title, or
    /// the executable's version-resource description when it has no window.
    /// Pure display — routing, the memory and the levels stay keyed by
    /// `exe_name`, which is what the audio service stores assignments under.
    pub display_name: Option<String>,
    /// Full image path of the executable, when the process could be opened.
    /// Internal plumbing: the description lookup reads it during enumeration,
    /// and the frontend identifies processes by PID and never needs the path.
    #[serde(skip_serializing)]
    pub exe_path: Option<String>,
    /// Whether the process was actually rendering audio when it was
    /// enumerated. `Inactive` sessions survive a pause, so "has a session" and
    /// "is sounding" are different facts; this is the second one, and the seed
    /// for the `session-activity` events that keep it current.
    pub playing: bool,
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
