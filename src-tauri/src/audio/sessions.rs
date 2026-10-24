//! Audio session enumeration via IAudioSessionManager2.
//!
//! Sessions are collected from **every active render device**, not just the
//! default one — apps already routed to a non-default device must stay visible
//! for re-routing.

use log::{debug, warn};
use windows::core::Interface;
use windows::Win32::Foundation::{CloseHandle, BOOL, HANDLE, HWND, LPARAM};
use windows::Win32::Media::Audio::{
    eRender, AudioSessionStateActive, IAudioSessionControl, IAudioSessionControl2,
    IAudioSessionEnumerator, IAudioSessionManager2, IMMDevice, IMMDeviceCollection,
    IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};

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

        // This app is not a program the user routes: it is the thing doing the
        // routing. Leave it out of its own list — see `exclude_own_processes`.
        exclude_own_processes(&mut sessions);

        Ok(sessions)
    })();

    crate::audio::uninit_com(com_owned);

    result
}

/// Drop every session that belongs to this app itself.
///
/// The app's own audio, when there is any, is rendered by a **WebView2 child
/// process**, not by the process that owns the window — so filtering just
/// `std::process::id()` would leave the child in the list. Everything in this
/// process's tree goes.
///
/// The executable name is a second fence over the **host process only**: it
/// catches an own-exe session the snapshot missed, but it cannot stand in for a
/// WebView2 child (that file is `msedgewebview2.exe`). So when the snapshot
/// fails, the tree degrades to this process alone and a child could still show
/// up — `own_process_tree` warns when that happens, because a silent partial
/// filter would look like a working one.
fn exclude_own_processes(sessions: &mut Vec<AudioSession>) {
    let tree = own_process_tree();
    let own_exe = std::env::current_exe().ok().and_then(|path| {
        path.file_name()
            .map(|name| name.to_string_lossy().to_string())
    });
    sessions.retain(|session| {
        if tree.contains(&session.pid) {
            debug!(
                "leaving this app's own process {} out of the list",
                session.pid
            );
            return false;
        }
        // `read_session` never leaves the name empty — it falls back to
        // "PID <n>" — so this is a plain case-insensitive name match.
        if let Some(own) = own_exe.as_deref() {
            if session.exe_name.eq_ignore_ascii_case(own) {
                debug!(
                    "leaving this app's own executable {} out of the list",
                    session.exe_name
                );
                return false;
            }
        }
        true
    });
}

/// This process's own pid plus every descendant, from one process snapshot.
///
/// A failed snapshot degrades to "just this process" rather than to an empty
/// set: the app's own pid is the one thing that is always knowable, and the
/// caller's exe-name fence covers the host process too. The warning is the part
/// that matters — the degradation is partial, and nothing else would say so.
fn own_process_tree() -> std::collections::HashSet<u32> {
    use std::collections::{HashMap, HashSet};

    let root = std::process::id();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    // SAFETY: TH32CS_SNAPPROCESS is the documented flag for a process snapshot;
    // the entry is sized before the walk, and the snapshot handle is closed
    // below whatever the walk returns.
    unsafe {
        let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(handle) => handle,
            Err(e) => {
                warn!("could not snapshot the process list: {e}");
                return HashSet::from([root]);
            }
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                children
                    .entry(entry.th32ParentProcessID)
                    .or_default()
                    .push(entry.th32ProcessID);
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        // SAFETY: `snapshot` came from CreateToolhelp32Snapshot and is closed once.
        let _ = CloseHandle(snapshot);
    }

    let mut tree: HashSet<u32> = HashSet::new();
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        if !tree.insert(pid) {
            continue;
        }
        if let Some(kids) = children.get(&pid) {
            stack.extend(kids.iter().copied());
        }
    }
    tree
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

/// Enumerate the running apps a person could name: processes owning a visible
/// top-level window, one entry per executable, shaped like sessions.
///
/// This is the feed picker's second tier. The audio-session list answers "who
/// is producing sound right now", but a feed's *receiving* end is often an app
/// that has never opened a render session at all — an idle recorder, a game in
/// its menu — and the capture pin it receives does not need one either: the
/// per-app assignment is written per process and covers sessions started after
/// it. What the user can aim at is an app with a window, so the list is
/// exactly that: `EnumWindows` gathers the visible top-level windows (cloaked
/// UWP hosts skipped — a suspended app is not running), one process lookup
/// names each, and the lowest pid of an executable is the entry — the address
/// every per-app assignment is written under. `playing` is `false` by
/// construction: nothing here says anything about sound.
pub fn enumerate_window_apps() -> Result<Vec<AudioSession>, AudioError> {
    let windowed = visible_window_pids();
    if windowed.is_empty() {
        return Ok(Vec::new());
    }

    // One entry per executable: the feed rule is per program, so a browser's
    // dozen processes are one destination. The lowest pid wins, and the drive-
    // letter image path rides along for the file-description fallback of the
    // display-name assembly.
    let mut best: std::collections::HashMap<String, AudioSession> =
        std::collections::HashMap::new();
    for pid in windowed {
        let Some((path, exe_name)) = process_meta::process_image(pid) else {
            // A pid the walk cannot name (it exited between the window walk
            // and here) is not a destination.
            continue;
        };
        let key = exe_name.to_ascii_lowercase();
        match best.get_mut(&key) {
            Some(winner) => {
                if pid < winner.pid {
                    winner.pid = pid;
                    winner.exe_name = exe_name;
                    winner.exe_path = Some(path);
                }
            }
            None => {
                best.insert(
                    key,
                    AudioSession {
                        pid,
                        exe_name,
                        display_name: None,
                        exe_path: Some(path),
                        playing: false,
                    },
                );
            }
        }
    }

    let mut apps: Vec<AudioSession> = best.into_values().collect();
    // A stable list is part of the picker's promise: the same machine running
    // the same apps hands back the same rows, whatever the window walk's order was.
    apps.sort_by_key(|a| a.exe_name.to_ascii_lowercase());
    // The self fence the session list also gets: this app is the picker's own
    // home, not a destination in it.
    exclude_own_processes(&mut apps);
    // Display names come from the same assembly the session list uses, so an
    // app named by its window there is named the same way here; the file
    // description fallback covers a visible window with no title.
    fill_display_names(&mut apps);
    Ok(apps)
}

/// The pids of every visible, uncloaked top-level window, from one Z-order walk.
fn visible_window_pids() -> Vec<u32> {
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, IsWindowVisible,
    };

    #[derive(Default)]
    struct PidCollector {
        pids: Vec<u32>,
    }

    // SAFETY: `lparam` is the `PidCollector` pointer passed to `EnumWindows`,
    // and USER32 invokes this on the calling thread, so the access is exclusive.
    unsafe extern "system" fn collect_pid(hwnd: HWND, lparam: LPARAM) -> BOOL {
        use windows::Win32::Foundation::BOOL;

        let collector = &mut *(lparam.0 as *mut PidCollector);
        // SAFETY: `hwnd` is a live window handle handed out by the walk.
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() {
                return BOOL(1);
            }
            // A cloaked window belongs to a UWP host keeping a suspended app's
            // place on screen: the app is not running, and naming it would
            // offer a destination whose process is a shell, not the app.
            let mut cloaked: u32 = 0;
            let cloaked_ok = DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut cloaked as *mut u32 as *mut _,
                std::mem::size_of::<u32>() as u32,
            );
            if cloaked_ok.is_ok() && cloaked != 0 {
                return BOOL(1);
            }
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid != 0 {
                collector.pids.push(pid);
            }
        }
        BOOL(1)
    }

    let mut collector = PidCollector::default();
    // SAFETY: the collector outlives the call on this same thread.
    let enumerated = unsafe {
        EnumWindows(
            Some(collect_pid),
            LPARAM(&mut collector as *mut PidCollector as isize),
        )
    };
    if let Err(e) = enumerated {
        log::warn!("window pid walk failed: {e}");
    }
    collector.pids
}

/// Get the executable name for a PID.
///
/// Shared with `routing.rs`, which needs the name to tell a system-critical
/// process from a routable one.
pub(crate) fn get_process_exe_name(pid: u32) -> Option<String> {
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
        // A callback failing on one session skips that session rather than the
        // rest of the walk — the same answer the open steps above give: the
        // program's other sessions on this endpoint, and the ones on later
        // devices, still get their value.
        match f(&volume) {
            Ok(Some(value)) => produced.push(value),
            Ok(None) => {}
            Err(e) => warn!("skipping session {i}: {e}"),
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
