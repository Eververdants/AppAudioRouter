//! Audio session enumeration via IAudioSessionManager2.

use log::info;
use windows::core::{Interface, PWSTR};
use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioSessionControl, IAudioSessionControl2, IAudioSessionEnumerator,
    IAudioSessionManager2, IMMDevice, IMMDeviceEnumerator,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED};

use crate::audio::AudioSession;

/// Enumerate all active audio sessions (processes with audio).
pub fn enumerate_sessions() -> Result<Vec<AudioSession>, String> {
    // SAFETY: COM init balanced with CoUninitialize.
    unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() {
            return Err(format!("CoInitializeEx failed: 0x{:08X}", hr.0));
        }
    }

    let result = (|| -> Result<Vec<AudioSession>, String> {
        // SAFETY: Create IMMDeviceEnumerator.
        let enumerator: IMMDeviceEnumerator = unsafe {
            CoCreateInstance(
                &IMMDeviceEnumerator::IID,
                None,
                CLSCTX_ALL,
            )
            .map_err(|e| format!("CoCreateInstance failed: {e}"))?
        };

        // SAFETY: GetDefaultAudioEndpoint with eRender/eConsole.
        let device: IMMDevice = unsafe {
            enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(|e| format!("GetDefaultAudioEndpoint failed: {e}"))?
        };

        // SAFETY: Activate IAudioSessionManager2.
        let session_manager: IAudioSessionManager2 = unsafe {
            device
                .Activate::<IAudioSessionManager2>(CLSCTX_ALL, None)
                .map_err(|e| format!("Activate(IAudioSessionManager2) failed: {e}"))?
        };

        // SAFETY: GetSessionEnumerator.
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

        let mut sessions = Vec::with_capacity(count as usize);

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

        Ok(sessions)
    })();

    // SAFETY: Balances CoInitializeEx.
    unsafe {
        CoUninitialize();
    }

    result
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
