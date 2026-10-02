//! Audio session enumeration via IAudioSessionManager2.
//!
//! Sessions are collected from **every active render device**, not just the
//! default one — apps already routed to a non-default device must stay visible
//! for re-routing.

use log::{debug, warn};
use windows::core::Interface;
use windows::Win32::Media::Audio::{
    eRender, AudioSessionStateActive, IAudioSessionControl, IAudioSessionControl2,
    IAudioSessionEnumerator, IAudioSessionManager2, IMMDevice, IMMDeviceCollection,
    IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

use crate::audio::AudioError;
use crate::audio::AudioSession;

/// Enumerate all active audio sessions (processes with audio), across all
/// active render devices.
pub fn enumerate_sessions() -> Result<Vec<AudioSession>, AudioError> {
    let com_owned = crate::audio::init_com()?;

    let result = (|| -> Result<Vec<AudioSession>, AudioError> {
        // SAFETY: MMDeviceEnumerator is the registered coclass for IMMDeviceEnumerator.
        let enumerator: IMMDeviceEnumerator = unsafe {
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| AudioError::Api(format!("CoCreateInstance failed: {e}")))?
        };

        // SAFETY: eRender + DEVICE_STATE_ACTIVE are valid params.
        let devices: IMMDeviceCollection = unsafe {
            enumerator
                .EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)
                .map_err(|e| AudioError::Api(format!("EnumAudioEndpoints failed: {e}")))?
        };
        let device_count = unsafe {
            devices
                .GetCount()
                .map_err(|e| AudioError::Api(format!("GetCount failed: {e}")))?
        };

        let mut sessions: Vec<AudioSession> = Vec::new();
        // PID -> whether any of its sessions was Active. One process can own
        // sessions on several devices; the router is per-process, so each PID is
        // listed once — and "is it sounding" is the OR across them.
        let mut seen_pids: std::collections::HashMap<u32, bool> = std::collections::HashMap::new();

        for d in 0..device_count {
            // SAFETY: d in [0, device_count).
            let device: IMMDevice = unsafe {
                devices
                    .Item(d)
                    .map_err(|e| AudioError::Api(format!("Item({d}) failed: {e}")))?
            };

            // One endpoint whose session manager will not activate must not
            // empty the process list: "every process but the ones on that
            // device" is usable, "no processes at all" is not.
            if let Err(e) = collect_device_sessions(&device, &mut sessions, &mut seen_pids) {
                warn!("skipping the sessions of device {d}: {e}");
            }
        }

        Ok(sessions)
    })();

    crate::audio::uninit_com(com_owned);

    result
}

/// Collect the sessions of one render device into `sessions`.
///
/// `seen_pids` deduplicates across devices and carries the OR of every
/// session's playing state, so a process sounding on any endpoint is listed as
/// playing.
fn collect_device_sessions(
    device: &IMMDevice,
    sessions: &mut Vec<AudioSession>,
    seen_pids: &mut std::collections::HashMap<u32, bool>,
) -> Result<(), AudioError> {
    // SAFETY: Activate IAudioSessionManager2 on an active render device.
    let session_manager: IAudioSessionManager2 = unsafe {
        device
            .Activate::<IAudioSessionManager2>(CLSCTX_ALL, None)
            .map_err(|e| AudioError::Api(format!("Activate(IAudioSessionManager2) failed: {e}")))?
    };

    // SAFETY: GetSessionEnumerator on an active session manager.
    let session_enum: IAudioSessionEnumerator = unsafe {
        session_manager
            .GetSessionEnumerator()
            .map_err(|e| AudioError::Api(format!("GetSessionEnumerator failed: {e}")))?
    };

    let count = unsafe {
        session_enum
            .GetCount()
            .map_err(|e| AudioError::Api(format!("GetCount failed: {e}")))?
    };

    for i in 0..count {
        // One session that will not open is skipped rather than fatal, for the
        // same reason a whole device is: it must not cost the user every other
        // process on this endpoint.
        let Some(session) = read_session(&session_enum, i) else {
            continue;
        };
        // One process can own sessions on several devices; the router is
        // per-process, so list each PID once — and OR the playing states
        // together, because sounding on any endpoint is sounding.
        match seen_pids.entry(session.pid) {
            std::collections::hash_map::Entry::Occupied(mut listed) => {
                if session.playing && !*listed.get() {
                    *listed.get_mut() = true;
                    if let Some(entry) = sessions.iter_mut().find(|s| s.pid == session.pid) {
                        entry.playing = true;
                    }
                }
            }
            std::collections::hash_map::Entry::Vacant(vacant) => {
                vacant.insert(session.playing);
                sessions.push(session);
            }
        }
    }

    Ok(())
}

/// Read one session of an enumerator into a listing entry, or `None` when it
/// carries nothing routable.
fn read_session(session_enum: &IAudioSessionEnumerator, index: i32) -> Option<AudioSession> {
    // SAFETY: index is within [0, count).
    let session_control: IAudioSessionControl = match unsafe { session_enum.GetSession(index) } {
        Ok(control) => control,
        Err(e) => {
            warn!("skipping session {index}: {e}");
            return None;
        }
    };
    // SAFETY: cast to IAudioSessionControl2 on a live session control.
    let session2: IAudioSessionControl2 = session_control.cast().ok()?;
    // SAFETY: GetProcessId on a live session.
    let pid = match unsafe { session2.GetProcessId() } {
        // PID 0 is the system-sounds session, which routing refuses anyway.
        Ok(0) => return None,
        Ok(pid) => pid,
        Err(e) => {
            warn!("skipping session {index}: {e}");
            return None;
        }
    };
    let exe_name = get_process_exe_name(pid).unwrap_or_else(|| format!("PID {pid}"));
    // "Has a session" and "is sounding" are different facts: a paused player
    // keeps its session. The state is also the seed the notification thread's
    // transitions hang off, so a program that was already playing at launch is
    // not mistaken for a quiet one.
    let playing = match unsafe { session_control.GetState() } {
        Ok(state) => state == AudioSessionStateActive,
        Err(e) => {
            debug!("session state of {exe_name} unreadable: {e}");
            false
        }
    };
    debug!("session: {exe_name} (PID {pid}, playing {playing})");
    Some(AudioSession {
        pid,
        exe_name,
        playing,
    })
}

/// Get the executable name for a PID.
///
/// Shared with `routing.rs`, which needs the name to tell a system-critical
/// process from a routable one.
pub(crate) fn get_process_exe_name(pid: u32) -> Option<String> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::ProcessStatus::GetProcessImageFileNameA;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    // SAFETY: OpenProcess with QUERY_LIMITED_INFORMATION is safe.
    let handle: HANDLE =
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()? };

    let result = (|| -> Option<String> {
        let mut buf = [0u8; 260];
        // SAFETY: buf is a valid mutable slice.
        let len = unsafe { GetProcessImageFileNameA(handle, &mut buf) };
        if len == 0 {
            return None;
        }
        let path = String::from_utf8_lossy(&buf[..len as usize]);
        let name = path
            .rfind('\\')
            .map(|idx| &path[idx + 1..])
            .unwrap_or(&path);
        Some(name.to_string())
    })();

    // SAFETY: CloseHandle balances OpenProcess.
    unsafe {
        let _ = CloseHandle(handle);
    }

    result
}
