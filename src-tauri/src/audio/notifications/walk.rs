//! The enumeration helpers a synchronisation pass reads the graph with.
//!
//! These walk the audio service's own view of the machine — the active render
//! endpoints, one device's session manager, that manager's session list, and the
//! per-session identifier everything downstream is keyed by — and turn what they
//! could read into a [`Witness`]: the record of what one pass proved is still
//! there, against which [`keep_session_watcher`] decides whether a watcher may
//! survive. A walk skips a flaky entry rather than costing the whole pass, so a
//! partial reading is what it is and never silently promoted to a complete one.

use std::collections::{HashMap, HashSet};

use log::warn;
use windows::core::Interface;
use windows::Win32::Media::Audio::{
    eRender, IAudioSessionControl2, IAudioSessionEnumerator, IAudioSessionManager2, IMMDevice,
    IMMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{CoTaskMemFree, CLSCTX_ALL};

use super::callbacks::WatchedSession;

/// One active render endpoint: its id (for the watch lists) and its interface.
pub(super) struct DeviceRef {
    pub(super) id: String,
    pub(super) raw: IMMDevice,
}

/// Enumerate active render endpoints with their ids, and say whether the list
/// names every endpoint the audio service reported.
///
/// One entry whose `Item` or `GetId` call failed is skipped rather than costing
/// the whole walk: the same hotplug race is skipped in `devices.rs` and
/// `sessions.rs`, and abandoning the walk here would leave the sessions of every
/// *other* device unwatched for the rest of the run — a new program never told
/// about, an expired one never dropped. The cost is that a skipped entry cannot
/// be told apart from a removed one, which is what the flag is for.
pub(super) fn active_render_devices(
    enumerator: &IMMDeviceEnumerator,
) -> Result<(Vec<DeviceRef>, bool), ()> {
    // SAFETY: eRender + DEVICE_STATE_ACTIVE are valid params.
    let Ok(collection) = (unsafe { enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) })
    else {
        return Err(());
    };
    let Ok(count) = (unsafe { collection.GetCount() }) else {
        return Err(());
    };
    let mut devices = Vec::with_capacity(count as usize);
    let mut complete = true;
    for i in 0..count {
        // SAFETY: i is within [0, count).
        let Ok(device) = (unsafe { collection.Item(i) }) else {
            warn!("session watch skipped device {i}: Item failed");
            complete = false;
            continue;
        };
        // SAFETY: GetId returns a PWSTR copied out and freed below.
        let Ok(pwstr) = (unsafe { device.GetId() }) else {
            warn!("session watch skipped device {i}: GetId failed");
            complete = false;
            continue;
        };
        let id = crate::audio::pwstr_to_string(&pwstr);
        // SAFETY: balances GetId's allocation.
        unsafe { CoTaskMemFree(Some(pwstr.0 as *const _)) };
        devices.push(DeviceRef { id, raw: device });
    }
    Ok((devices, complete))
}

/// Activate the session manager of one device.
pub(super) fn open_session_manager(device: &IMMDevice) -> Result<IAudioSessionManager2, ()> {
    // SAFETY: activating IAudioSessionManager2 on an active render device.
    unsafe { device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) }.map_err(|_| ())
}

/// Every session of one device, and whether the whole list was read.
///
/// `None` means the enumerator itself was unavailable. The second value is
/// `false` when the enumerator answered but one of its entries did not: the list
/// is then a partial one, and a partial list must not be used to prove that a
/// session is gone — that is the same blind walk that was fixed for endpoints,
/// one level down.
pub(super) fn sessions_of(
    manager: &IAudioSessionManager2,
) -> Option<(Vec<IAudioSessionControl2>, bool)> {
    // SAFETY: GetSessionEnumerator on a live session manager.
    let session_enum: IAudioSessionEnumerator = unsafe { manager.GetSessionEnumerator() }.ok()?;
    let count = unsafe { session_enum.GetCount() }.ok()?;
    let mut sessions = Vec::with_capacity(count as usize);
    let mut complete = true;
    for i in 0..count {
        // SAFETY: i is within [0, count).
        let Ok(control) = (unsafe { session_enum.GetSession(i) }) else {
            complete = false;
            continue;
        };
        let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
            // The entry was read; it just is not a session this module can watch.
            // Say so rather than dropping it silently, or its device would be
            // marked as fully read while one of its sessions went unaccounted.
            complete = false;
            continue;
        };
        sessions.push(control2);
    }
    Some((sessions, complete))
}

/// A session's unique identifier, or an empty string when it cannot be read.
pub(super) fn session_identifier(session: &IAudioSessionControl2) -> String {
    // SAFETY: GetSessionIdentifier returns a PWSTR copied out and freed below.
    let Ok(pwstr) = (unsafe { session.GetSessionIdentifier() }) else {
        return String::new();
    };
    let id = crate::audio::pwstr_to_string(&pwstr);
    // SAFETY: balances GetSessionIdentifier's allocation.
    unsafe { CoTaskMemFree(Some(pwstr.0 as *const _)) };
    id
}

/// The endpoints this thread holds watchers on: every session manager it
/// registered, plus the device of every session watcher it holds.
///
/// Both halves are needed: a manager whose `RegisterSessionNotification` was
/// refused is not in the map, yet its sessions are still watched, and a device
/// that left with its sessions behind would otherwise go unprobed.
pub(super) fn watched_device_ids(
    watched_managers: &HashMap<String, IAudioSessionManager2>,
    watched_sessions: &HashMap<String, WatchedSession>,
) -> HashSet<String> {
    let mut ids: HashSet<String> = watched_managers.keys().cloned().collect();
    ids.extend(
        watched_sessions
            .values()
            .map(|watched| watched.device_id.clone()),
    );
    ids
}

/// What one synchronisation pass proved is still there.
///
/// The four sets travel together because the prune needs all of them to answer
/// one question — may this watcher still exist? — and a pass that read half the
/// graph can only ever answer it in degrees.
#[derive(Clone, Default)]
pub(super) struct Witness {
    /// Endpoints this pass can account for: named by the walk, or skipped by it
    /// and kept by [`super::absence::AbsenceLedger`] after being asked about by that exact id.
    pub(super) devices: HashSet<String>,
    /// Sessions named by a session list that was read to the end.
    pub(super) sessions: HashSet<String>,
    /// Endpoints whose session list this pass read to the end. A list with an
    /// entry that could not be read is *not* one of these: it names some of the
    /// device's sessions, which proves nothing about the rest.
    pub(super) walked: HashSet<String>,
    /// Watched sessions that reported themselves expired.
    pub(super) expired: HashSet<String>,
}

/// Whether one watched session survives this pass.
///
/// The four readings of an absent session id, in the order they are settled:
/// the walk saw it, so it lives; its endpoint is gone, so it went with it; it
/// reported itself expired; and only if none of that applies, the endpoint is
/// still accounted for but its session list was not read to the end, which
/// proves nothing.
pub(super) fn keep_session_watcher(id: &str, device_id: &str, witness: &Witness) -> bool {
    if witness.sessions.contains(id) {
        return true;
    }
    if !witness.devices.contains(device_id) {
        return false;
    }
    if witness.expired.contains(id) {
        return false;
    }
    !witness.walked.contains(device_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::notifications::fixtures::set;

    /// The four readings of a session id missing from this pass's list, which
    /// is the whole difference between dropping a live callback and holding a
    /// dead one.
    #[test]
    fn an_absent_session_is_kept_only_while_the_walk_says_nothing_about_it() {
        let read = Witness {
            devices: set(&["present"]),
            sessions: set(&[]),
            walked: set(&["present"]),
            expired: set(&[]),
        };
        let unwalked = Witness {
            walked: set(&[]),
            ..read.clone()
        };
        let gone = Witness {
            devices: set(&[]),
            ..read.clone()
        };

        // The endpoint is gone: everything on it went with it.
        assert!(!keep_session_watcher("s", "gone", &gone));
        // Its list was read to the end and did not name the session.
        assert!(!keep_session_watcher("s", "present", &read));
        // Its list could not be read, so the walk proves nothing — unless the
        // session itself reports expired.
        assert!(keep_session_watcher("s", "present", &unwalked));
        assert!(!keep_session_watcher(
            "s",
            "present",
            &Witness {
                expired: set(&["s"]),
                ..unwalked.clone()
            }
        ));
        // And a session the walk did see is kept whatever else says.
        assert!(keep_session_watcher(
            "s",
            "present",
            &Witness {
                sessions: set(&["s"]),
                expired: set(&["s"]),
                ..gone.clone()
            }
        ));
    }
}
