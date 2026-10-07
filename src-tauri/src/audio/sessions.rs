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
    IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

use crate::audio::process_meta;
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
            let device: IMMDevice = match unsafe { devices.Item(d) } {
                Ok(device) => device,
                // An endpoint disappearing between GetCount and its Item call
                // is a hotplug race; the sessions of the devices that remain
                // are still worth listing, so skip this one the way a device
                // whose session manager will not activate is skipped below.
                Err(e) => {
                    warn!("skipping the sessions of device {d}: Item failed: {e}");
                    continue;
                }
            };

            // One endpoint whose session manager will not activate must not
            // empty the process list: "every process but the ones on that
            // device" is usable, "no processes at all" is not.
            if let Err(e) = collect_device_sessions(&device, &mut sessions, &mut seen_pids) {
                warn!("skipping the sessions of device {d}: {e}");
            }
        }

        fill_display_names(&mut sessions);

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
    let (exe_name, exe_path) = match process_meta::process_image(pid) {
        Some((path, name)) => (name, Some(path)),
        None => (
            get_process_exe_name(pid).unwrap_or_else(|| format!("PID {pid}")),
            None,
        ),
    };
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
        display_name: None,
        exe_path,
        playing,
    })
}

/// Fill in the display names of a collected session list.
///
/// Window titles first — one `EnumWindows` pass for the whole list, not one
/// per session — then the executable's version-resource description when the
/// process has no titled window. The description is read once per image path:
/// a browser's dozen processes share one file, and one version-resource read
/// per session per refresh would be a dozen. A process that carries neither
/// keeps `None`, and the frontend shows `exe_name` as it always has.
///
/// This runs per refresh and the refresh is event-driven, never a poll — the
/// read of the title is what makes the display *follow* the window rather
/// than freeze at first sight, which is the point of the field.
fn fill_display_names(sessions: &mut [AudioSession]) {
    let pids: Vec<u32> = sessions.iter().map(|session| session.pid).collect();
    let titles = process_meta::window_titles(&pids);
    let mut descriptions: std::collections::HashMap<String, Option<String>> =
        std::collections::HashMap::new();
    for session in sessions {
        session.display_name = match titles.get(&session.pid) {
            Some(title) => Some(title.clone()),
            None => session.exe_path.as_deref().and_then(|path| {
                descriptions
                    .entry(path.to_ascii_lowercase())
                    .or_insert_with(|| process_meta::file_description(path))
                    .clone()
            }),
        };
    }
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

/// Apply `f` to the [`ISimpleAudioVolume`] of every live session owned by
/// `pid`, across all active render devices.
///
/// Returns whatever the closures produced — one entry per session volume they
/// answered for. An empty result means the process has no live audio session
/// right now, which is a normal state around a session's edges rather than an
/// error.
fn with_session_volumes<T>(
    pid: u32,
    mut f: impl FnMut(&ISimpleAudioVolume) -> Result<Option<T>, AudioError>,
) -> Result<Vec<T>, AudioError> {
    let com_owned = crate::audio::init_com()?;

    let result = (|| -> Result<Vec<T>, AudioError> {
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

        let mut produced: Vec<T> = Vec::new();
        for d in 0..device_count {
            // SAFETY: d in [0, device_count).
            let device: IMMDevice = match unsafe { devices.Item(d) } {
                Ok(device) => device,
                // An endpoint disappearing between GetCount and its Item call
                // is a hotplug race; the sessions of the devices that remain
                // are still worth listing, so skip this one the way a device
                // whose session manager will not activate is skipped below.
                Err(e) => {
                    warn!("skipping the sessions of device {d}: Item failed: {e}");
                    continue;
                }
            };
            // One endpoint whose session manager will not activate must not
            // lose the program's volume elsewhere: skip it the way the
            // process list does.
            if let Err(e) = with_device_session_volumes(&device, pid, &mut f, &mut produced) {
                warn!("skipping the sessions of device {d}: {e}");
            }
        }
        Ok(produced)
    })();

    crate::audio::uninit_com(com_owned);

    result
}

/// Feed every session of `device` that belongs to `pid` to `f`.
fn with_device_session_volumes<T>(
    device: &IMMDevice,
    pid: u32,
    f: &mut impl FnMut(&ISimpleAudioVolume) -> Result<Option<T>, AudioError>,
    produced: &mut Vec<T>,
) -> Result<(), AudioError> {
    // SAFETY: Activate IAudioSessionManager2 on an active render device.
    let manager: IAudioSessionManager2 = unsafe {
        device
            .Activate::<IAudioSessionManager2>(CLSCTX_ALL, None)
            .map_err(|e| AudioError::Api(format!("Activate(IAudioSessionManager2) failed: {e}")))?
    };
    // SAFETY: GetSessionEnumerator on an active session manager.
    let session_enum: IAudioSessionEnumerator = unsafe {
        manager
            .GetSessionEnumerator()
            .map_err(|e| AudioError::Api(format!("GetSessionEnumerator failed: {e}")))?
    };
    let session_count = unsafe {
        session_enum
            .GetCount()
            .map_err(|e| AudioError::Api(format!("GetCount failed: {e}")))?
    };

    for i in 0..session_count {
        // One session that will not open is skipped rather than fatal, exactly
        // as the enumeration path (`read_session`) skips it: a session expiring
        // between GetCount and its GetSession call is an everyday race, and
        // aborting the whole device on it would leave the program's own live
        // session — sitting on the very same endpoint — unanswerable. A walk
        // that answers for nothing reads as "no live session" to the callers,
        // which is how a stopped route would skip handing the program's
        // pre-route loudness back.
        //
        // SAFETY: i in [0, session_count).
        let control: IAudioSessionControl = match unsafe { session_enum.GetSession(i) } {
            Ok(control) => control,
            Err(e) => {
                warn!("skipping session {i}: {e}");
                continue;
            }
        };
        // SAFETY: cast to IAudioSessionControl2 on a live session control.
        let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
            continue;
        };
        // SAFETY: GetProcessId on a live session.
        let session_pid = match unsafe { control2.GetProcessId() } {
            Ok(pid) => pid,
            Err(e) => {
                warn!("skipping session {i}: {e}");
                continue;
            }
        };
        if session_pid != pid {
            continue;
        }
        // SAFETY: the session control object implements ISimpleAudioVolume;
        // this is the documented per-session volume path.
        let volume: ISimpleAudioVolume = control
            .cast()
            .map_err(|e| AudioError::Api(format!("cast(ISimpleAudioVolume) failed: {e}")))?;
        if let Some(value) = f(&volume)? {
            produced.push(value);
        }
    }
    Ok(())
}

/// Set the master volume (0.0–1.0) of every live audio session owned by
/// `pid`. Returns the number of sessions touched — 0 means the program has no
/// live session to speak of, and the caller should say so rather than claim
/// the value was applied.
pub fn set_session_volume(pid: u32, volume: f32) -> Result<usize, AudioError> {
    let volume = volume.clamp(0.0, 1.0);
    let touched = with_session_volumes(pid, |v| {
        // SAFETY: eventcontext = null means no session event notification GUID.
        unsafe { v.SetMasterVolume(volume, std::ptr::null()) }
            .map_err(|e| AudioError::Api(format!("SetMasterVolume failed: {e}")))?;
        Ok(Some(()))
    })?;
    Ok(touched.len())
}

/// The master volume (0.0–1.0) of the first live session owned by `pid`, or
/// `None` when it has no live session. A process's sessions share what the
/// volume mixer shows, so the first one found is as good as any.
pub fn get_session_volume(pid: u32) -> Result<Option<f32>, AudioError> {
    let mut taken = false;
    let found = with_session_volumes(pid, |v| {
        if taken {
            return Ok(None);
        }
        // SAFETY: read-only query on a live session volume.
        let value = unsafe { v.GetMasterVolume() }
            .map_err(|e| AudioError::Api(format!("GetMasterVolume failed: {e}")))?;
        taken = true;
        Ok(Some(value))
    })?;
    Ok(found.into_iter().next())
}
