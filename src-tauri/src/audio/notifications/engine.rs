//! One synchronisation pass over the audio graph.
//!
//! [`sync`] is the whole engine: it walks the active render endpoints
//! ([`super::walk`]), wires this thread's session watcher onto each and an
//! expiry watcher onto every session it can read, asks the audio service about
//! the endpoints the walk could not name ([`super::absence`]), then prunes every
//! watcher the pass can no longer account for — unregistering each COM callback
//! before its owning interface is released. It is run once when the thread
//! starts (both callback kinds report only *changes*) and again on every batch
//! that moved a list, so a session predating the app is wired up and nothing
//! silently slips off the watched set between events.
//!
//! Every COM pointer here belongs to the single owner thread [`super::thread`]
//! handed it; nothing in this module crosses a thread or reaches an
//! `unsafe impl Send`.

use std::collections::{HashMap, HashSet};
use std::sync::mpsc::Sender;
use std::sync::Arc;

use log::warn;
use windows::core::Interface;
use windows::Win32::Media::Audio::{
    AudioSessionStateActive, AudioSessionStateInactive, IAudioSessionControl,
    IAudioSessionControl2, IAudioSessionEvents, IAudioSessionManager2, IAudioSessionNotification,
    IMMDeviceEnumerator,
};

use super::absence::{clock_ms, endpoint_probe, session_self_reports_gone, AbsenceLedger};
use super::callbacks::{
    forget_session, note_session_state, SessionEvents, Sounding, WatchedSession,
};
use super::walk::{
    active_render_devices, keep_session_watcher, open_session_manager, session_identifier,
    sessions_of, watched_device_ids, DeviceRef, Witness,
};
use super::Msg;

/// Wire the session watcher onto every active render device and the expiry
/// watcher onto every session, dropping registrations that no longer exist.
///
/// `absences` carries what this thread already knows about endpoints an earlier
/// pass could not name: each one is asked about by id, and only an endpoint the
/// service cannot be asked about at all defers its prune, and only under a bound.
/// See [`AbsenceLedger`].
pub(super) fn sync(
    enumerator: &IMMDeviceEnumerator,
    session_client: &IAudioSessionNotification,
    tx: &Sender<Msg>,
    sounding: &Sounding,
    watched_managers: &mut HashMap<String, IAudioSessionManager2>,
    watched_sessions: &mut HashMap<String, WatchedSession>,
    absences: &mut AbsenceLedger,
) {
    let Ok((mut devices, endpoints_are_all_named)) = active_render_devices(enumerator) else {
        return;
    };

    // What the walk named, against what this thread still holds watchers on.
    // The two only agree when the walk was complete, so the gap between them is
    // asked about by id rather than assumed in either direction: an endpoint the
    // service resolves to nothing active is gone and gets pruned on the spot, one
    // it calls active was merely skipped by the walk and is walked here like any
    // other endpoint of this pass — which keeps its new sessions watched and its
    // departed ones prunable — and one the service cannot be asked about keeps
    // its watchers for as long as the ledger allows.
    let named: HashSet<String> = devices.iter().map(|device| device.id.clone()).collect();
    let watched_ids = watched_device_ids(watched_managers, watched_sessions);
    absences.sweep(&named, &watched_ids);
    let mut witness = Witness::default();
    if !endpoints_are_all_named {
        let now = clock_ms();
        let unexplained: Vec<String> = watched_ids
            .iter()
            .filter(|id| !named.contains(*id))
            .cloned()
            .collect();
        for id in unexplained {
            let (answer, device) = endpoint_probe(enumerator, &id);
            if !absences.tolerate(&id, answer, now) {
                continue;
            }
            // Accounted for whatever the answer was: that is exactly what
            // `tolerate` just decided, and an endpoint with no device to walk
            // (the unaskable case) must still hold its watchers this pass.
            witness.devices.insert(id.clone());
            if let Some(device) = device {
                devices.push(device);
            }
        }
    }

    for device in &devices {
        // Accounted for before anything is read off it: a device whose manager
        // will not activate is still present, and the watchers on it must not be
        // dropped because this pass could not look at them.
        witness.devices.insert(device.id.clone());
        watch_device(
            device,
            session_client,
            tx,
            sounding,
            watched_managers,
            watched_sessions,
            &mut witness,
        );
    }

    // Sessions this pass can neither see nor lose: their endpoint is still
    // accounted for, but its session list could not be read to the end, so the
    // walk says nothing about them and their absence proves nothing. Ask each
    // one for itself instead of keeping it on the assumption that the walk simply
    // missed it — otherwise a device whose list stays unreadable keeps an expired
    // session's two COM registrations, and every expiry it still reports provokes
    // another full re-enumeration, for the rest of the run.
    for (id, watched) in watched_sessions.iter() {
        let unread = !witness.sessions.contains(id.as_str())
            && witness.devices.contains(&watched.device_id)
            && !witness.walked.contains(&watched.device_id);
        if unread && session_self_reports_gone(watched) {
            witness.expired.insert(id.clone());
        }
    }

    prune_watchers(
        session_client,
        sounding,
        watched_managers,
        watched_sessions,
        &witness,
    );
}

/// Register this thread's session watcher on one endpoint's session manager, and
/// the expiry watcher on every session of it this pass could read.
///
/// Nothing is reported upward: a device whose manager will not activate is simply
/// left unwalked, and the sessions already watched on it survive the pass because
/// this pass cannot say what became of them.
fn watch_device(
    device: &DeviceRef,
    session_client: &IAudioSessionNotification,
    tx: &Sender<Msg>,
    sounding: &Sounding,
    watched_managers: &mut HashMap<String, IAudioSessionManager2>,
    watched_sessions: &mut HashMap<String, WatchedSession>,
    witness: &mut Witness,
) {
    let manager = match watched_managers.get(&device.id) {
        Some(manager) => manager.clone(),
        None => {
            let Ok(manager) = open_session_manager(&device.raw) else {
                return;
            };

            // SAFETY: manager and session_client are owned and used on this one
            // notification thread. The manager is kept in the map below, which is
            // what keeps this registration alive between syncs.
            match unsafe { manager.RegisterSessionNotification(session_client) } {
                Ok(()) => {
                    watched_managers.insert(device.id.clone(), manager.clone());
                }
                Err(e) => warn!("could not watch sessions on {}: {e}", device.id),
            }
            manager
        }
    };

    // `None` here means the device's sessions could not be read at all, and a
    // second value of `false` that only some of them could be: either way the
    // list names less than the device holds, which is what keeps it out of
    // `walked` and off the prune list.
    let Some((sessions, read_to_the_end)) = sessions_of(&manager) else {
        return;
    };
    let mut accounted = read_to_the_end;
    for session in sessions {
        if !watch_session(session, &device.id, tx, sounding, watched_sessions, witness) {
            accounted = false;
        }
    }
    if accounted {
        witness.walked.insert(device.id.clone());
    } else {
        warn!("session list of {} was only partly read", device.id);
    }
}

/// Register the expiry watcher on one session, unless this thread watches it
/// already — which is also what keeps a pass that named the same endpoint twice
/// (through the walk and through a probe of the same id) from wiring it in
/// twice.
///
/// Returns `false` when this entry could not be read at all, meaning the
/// device's list does not account for every session on it and therefore cannot
/// be trusted to prove that any session it left out has gone.
fn watch_session(
    session: IAudioSessionControl2,
    device_id: &str,
    tx: &Sender<Msg>,
    sounding: &Sounding,
    watched_sessions: &mut HashMap<String, WatchedSession>,
    witness: &mut Witness,
) -> bool {
    let id = session_identifier(&session);
    if id.is_empty() {
        return false;
    }
    // Every session that is read is accounted for, whether or not this pass is
    // the one that registered its watcher — the prune compares against this set.
    witness.sessions.insert(id.clone());
    if watched_sessions.contains_key(&id) {
        return true;
    }
    // SAFETY: GetProcessId on the session control this thread just enumerated and
    // owns.
    let pid = unsafe { session.GetProcessId() }.unwrap_or(0);
    let events: IAudioSessionEvents = SessionEvents {
        tx: tx.clone(),
        // Read here, on the owner thread, while the control is in hand: the state
        // callback has no identity of its own to report. `0` reads as "unknown"
        // and only costs the liveness events, never the expiry ones.
        pid,
        session_id: id.clone(),
        sounding: Arc::clone(sounding),
    }
    .into();
    let Ok(control) = session.cast::<IAudioSessionControl>() else {
        return true;
    };
    // SAFETY: the callback and the control are kept alive in `watched_sessions`,
    // so this registration remains valid until it is unregistered during a prune
    // or at thread teardown.
    if unsafe { session.RegisterAudioSessionNotification(&events) }.is_err() {
        return true;
    }
    // Seed the ledger with the state as it stands. The frontend learns the same
    // fact from the list it is about to enumerate, and an unseeded ledger would
    // read this session's first pause as "nothing changed" — leaving a program
    // that fell silent drawn as sounding.
    if pid != 0 {
        // SAFETY: the session control is the one just read.
        let state = unsafe { session.GetState() }.unwrap_or(AudioSessionStateInactive);
        note_session_state(sounding, pid, &id, state == AudioSessionStateActive);
    }
    watched_sessions.insert(
        id,
        WatchedSession {
            control,
            events,
            device_id: device_id.to_string(),
        },
    );
    true
}

/// Drop watchers for devices and sessions that no longer exist, unregistering
/// each COM callback before its owning interface is released, and forget each
/// dropped session in the liveness ledger.
///
/// Every reading of "not in this pass's list" is decided by
/// [`keep_session_watcher`], which is what keeps a walk that could not read one
/// device from dropping the callbacks of sessions still playing on it.
fn prune_watchers(
    session_client: &IAudioSessionNotification,
    sounding: &Sounding,
    watched_managers: &mut HashMap<String, IAudioSessionManager2>,
    watched_sessions: &mut HashMap<String, WatchedSession>,
    witness: &Witness,
) {
    watched_managers.retain(|id, manager| {
        if witness.devices.contains(id) {
            return true;
        }
        // SAFETY: balances the registration recorded in this map.
        unsafe {
            let _ = manager.UnregisterSessionNotification(session_client);
        }
        false
    });
    watched_sessions.retain(|id, watched| {
        if keep_session_watcher(id, &watched.device_id, witness) {
            return true;
        }
        // SAFETY: balances the registration recorded in this map.
        unsafe {
            let _ = watched
                .control
                .UnregisterAudioSessionNotification(&watched.events);
        }
        forget_session(sounding, id);
        false
    });
}
