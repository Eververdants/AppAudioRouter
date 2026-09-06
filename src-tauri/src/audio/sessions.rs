//! Audio session enumeration via IAudioSessionManager2.
//!
//! Sessions are collected from **every active render device**, not just the
//! default one — apps already routed to a non-default device must stay visible
//! for re-routing.

use log::info;
use windows::core::{Interface, PWSTR};
use windows::Win32::Media::Audio::{
    eRender, IAudioSessionControl, IAudioSessionControl2, IAudioSessionEnumerator,
    IAudioSessionManager2, IMMDevice, IMMDeviceCollection, IMMDeviceEnumerator,
    MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

use crate::audio::AudioSession;

/// Enumerate all active audio sessions (processes with audio), across all
/// active render devices.
pub fn enumerate_sessions() -> Result<Vec<AudioSession>, String> {
    let com_owned = crate::audio::init_com()?;

    let result = (|| -> Result<Vec<AudioSession>, String> {
        // SAFETY: MMDeviceEnumerator is the registered coclass for IMMDeviceEnumerator.
        let enumerator: IMMDeviceEnumerator = unsafe {
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| format!("CoCreateInstance failed: {e}"))?
        };

        // SAFETY: eRender + DEVICE_STATE_ACTIVE are valid params.
        let devices: IMMDeviceCollection = unsafe {
            enumerator
                .EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)
                .map_err(|e| format!("EnumAudioEndpoints failed: {e}"))?
        };
        let device_count = unsafe {
            devices
                .GetCount()
                .map_err(|e| format!("GetCount failed: {e}"))?
        };

        let mut sessions: Vec<AudioSession> = Vec::new();
        let mut seen_pids = std::collections::HashSet::new();

        for d in 0..device_count {
            // SAFETY: d in [0, device_count).
            let device: IMMDevice = unsafe {
                devices
                    .Item(d)
                    .map_err(|e| format!("Item({d}) failed: {e}"))?
            };

            collect_device_sessions(&device, &mut sessions, &mut seen_pids)?;
        }

        Ok(sessions)
    })();

    crate::audio::uninit_com(com_owned);

    result
}

/// Collect the sessions of one render device into `sessions`.
fn collect_device_sessions(
    device: &IMMDevice,
    sessions: &mut Vec<AudioSession>,
    seen_pids: &mut std::collections::HashSet<u32>,
) -> Result<(), String> {
    // SAFETY: Activate IAudioSessionManager2 on an active render device.
    let session_manager: IAudioSessionManager2 = unsafe {
        device
            .Activate::<IAudioSessionManager2>(CLSCTX_ALL, None)
            .map_err(|e| format!("Activate(IAudioSessionManager2) failed: {e}"))?
    };

    // SAFETY: GetSessionEnumerator on an active session manager.
    let session_enum: IAudioSessionEnumerator = unsafe {
        session_manager
            .GetSessionEnumerator()
            .map_err(|e| format!("GetSessionEnumerator failed: {e}"))?
    };

    let count = unsafe {
        session_enum
            .GetCount()
            .map_err(|e| format!("GetCount failed: {e}"))?
    };

    for i in 0..count {
        // SAFETY: i in [0, count).
        let session_control: IAudioSessionControl = unsafe {
            session_enum
                .GetSession(i)
                .map_err(|e| format!("GetSession({i}) failed: {e}"))?
        };

        // SAFETY: cast to IAudioSessionControl2.
        let session2: IAudioSessionControl2 = session_control
            .cast::<IAudioSessionControl2>()
            .map_err(|e| format!("cast(IAudioSessionControl2) failed: {e}"))?;

        let pid = unsafe {
            session2
                .GetProcessId()
                .map_err(|e| format!("GetProcessId({i}) failed: {e}"))?
        };

        if pid == 0 {
            continue;
        }

        // One process can own sessions on several devices; the router is
        // per-process, so list each PID once.
        if !seen_pids.insert(pid) {
            continue;
        }

        // SAFETY: GetDisplayName returns a PWSTR we must free.
        let display_pwstr = unsafe {
            session2
                .GetDisplayName()
                .map_err(|e| format!("GetDisplayName({i}) failed: {e}"))?
        };
        let display_name = pwstr_to_string(&display_pwstr);
        unsafe {
            windows::Win32::System::Com::CoTaskMemFree(Some(display_pwstr.0 as *const _));
        }

        let exe_name = get_process_exe_name(pid).unwrap_or_else(|| format!("PID {pid}"));

        info!("session: {exe_name} (PID {pid}) display={display_name}");
        sessions.push(AudioSession {
            pid,
            exe_name,
            display_name,
        });
    }

    Ok(())
}

/// Get the executable name for a PID.
fn get_process_exe_name(pid: u32) -> Option<String> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::ProcessStatus::GetProcessImageFileNameA;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    // SAFETY: OpenProcess with QUERY_LIMITED_INFORMATION is safe.
    let handle: HANDLE = unsafe {
        OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?
    };

    let result = (|| -> Option<String> {
        let mut buf = [0u8; 260];
        // SAFETY: buf is a valid mutable slice.
        let len = unsafe { GetProcessImageFileNameA(handle, &mut buf) };
        if len == 0 {
            return None;
        }
        let path = String::from_utf8_lossy(&buf[..len as usize]);
        let name = path.rfind('\\').map(|idx| &path[idx + 1..]).unwrap_or(&path);
        Some(name.to_string())
    })();

    // SAFETY: CloseHandle balances OpenProcess.
    unsafe {
        let _ = CloseHandle(handle);
    }

    result
}

fn pwstr_to_string(pwstr: &PWSTR) -> String {
    if pwstr.is_null() {
        return String::new();
    }
    unsafe {
        let mut len = 0;
        let mut ptr = pwstr.0;
        while *ptr != 0 {
            len += 1;
            ptr = ptr.add(1);
        }
        let slice = std::slice::from_raw_parts(pwstr.0, len);
        String::from_utf16_lossy(slice)
    }
}
