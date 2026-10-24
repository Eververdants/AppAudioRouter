//! The thread itself: start it, then run its loop until the process ends.
//!
//! [`start`] is the module's one entry point and spawns the dedicated MTA
//! thread; [`watch`] is that thread's body. It owns every COM pointer in this
//! module — the enumerator, the two registered notification objects, the maps of
//! session managers and session watchers wired up by [`super::engine::sync`].
//! The callbacks Windows invokes on its own RPC threads hand work back through a
//! channel, so the loop drains whatever piled up into a single batch (one
//! hotplug or a browser waking ten tabs costs one re-enumeration, not one per
//! notification), forwards each state transition on its own in arrival order, and
//! only re-synchronises and emits `audio-changed` when a list actually moved. On
//! the way out it releases every registration it took, in reverse.

use std::collections::HashMap;
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};

use log::warn;
use tauri::{AppHandle, Emitter};
use windows::Win32::Media::Audio::{
    IAudioSessionManager2, IAudioSessionNotification, IMMDeviceEnumerator, IMMNotificationClient,
    MMDeviceEnumerator,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

use super::absence::AbsenceLedger;
use super::callbacks::{EndpointWatcher, SessionWatcher, Sounding, WatchedSession};
use super::engine::sync;
use super::{AudioChanged, Msg, SessionActivity, AUDIO_CHANGED_EVENT, SESSION_ACTIVITY_EVENT};

/// Start watching, if the audio graph allows it.
///
/// Failures are logged and swallowed: the lists stay refreshable by hand, which
/// is what every version up to 2.1 did, and a notification callback that will not
/// register must never keep the window from opening.
pub fn start(app: AppHandle) {
    if std::thread::Builder::new()
        .name("audio-notifications".to_string())
        .spawn(move || watch(app))
        .is_err()
    {
        warn!("could not start the audio notification thread");
    }
}

/// Thread body: register, then turn callbacks into re-synchronisations and events.
fn watch(app: AppHandle) {
    let com_owned = match crate::audio::init_com() {
        Ok(owned) => owned,
        Err(e) => {
            warn!("audio notifications disabled: {e}");
            return;
        }
    };

    // SAFETY: MMDeviceEnumerator is the registered coclass for IMMDeviceEnumerator.
    let enumerator: IMMDeviceEnumerator =
        match unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) } {
            Ok(enumerator) => enumerator,
            Err(e) => {
                warn!("audio notifications disabled: {e}");
                crate::audio::uninit_com(com_owned);
                return;
            }
        };

    let (tx, rx) = channel::<Msg>();
    let endpoint_client: IMMNotificationClient = EndpointWatcher { tx: tx.clone() }.into();
    // SAFETY: the callback object is held by this thread until it unregisters
    // below, which happens before the thread exits.
    if unsafe {
        enumerator
            .RegisterEndpointNotificationCallback(&endpoint_client)
            .is_err()
    } {
        warn!("endpoint notifications unavailable; device changes stay manual");
    }

    let session_client: IAudioSessionNotification = SessionWatcher { tx: tx.clone() }.into();
    // What this thread has already wired up, so a sync only pays for what moved.
    // These maps are also the owners that keep the COM registrations alive.
    let mut watched_managers: HashMap<String, IAudioSessionManager2> = HashMap::new();
    let mut watched_sessions: HashMap<String, WatchedSession> = HashMap::new();
    // Which sessions are playing, so a state callback about one session can be
    // reported as a change of its process. Shared with the callback objects,
    // which Windows invokes on its own threads.
    let sounding: Sounding = Arc::new(Mutex::new(HashMap::new()));
    // Endpoint absences a partial walk could not prove, carried from one pass to
    // the next so the deferral stays bounded. See [`AbsenceLedger`].
    let mut absences = AbsenceLedger::default();

    // Wire the session watchers onto the graph as it already is. Both callbacks
    // only ever report *changes*, so without this pass a session that started
    // before the app launched would never be watched, and no event would arrive
    // for it until an endpoint changed. The frontend enumerates on its own at
    // startup, which is why this pass reports nothing.
    sync(
        &enumerator,
        &session_client,
        &tx,
        &sounding,
        &mut watched_managers,
        &mut watched_sessions,
        &mut absences,
    );

    while let Ok(first) = rx.recv() {
        // Drain whatever piled up while the last change was being handled: one
        // hotplug, or a browser waking ten tabs, should cost a single
        // re-enumeration rather than one per notification.
        let mut batch = vec![first];
        while let Ok(msg) = rx.try_recv() {
            batch.push(msg);
        }

        let mut devices = false;
        let mut sessions = false;
        for msg in &batch {
            match msg {
                // Endpoints carry sessions with them, so an endpoint change
                // makes both lists stale even though no session callback fired.
                Msg::Endpoint => {
                    devices = true;
                    sessions = true;
                }
                Msg::SessionCreated | Msg::SessionExpired => sessions = true,
                // Not a list change: the session is still there, it just went
                // quiet or started up. Forwarded below, without paying for a
                // re-enumeration the lists do not need.
                Msg::SessionState { .. } => {}
            }
        }
        // Every state transition in the batch goes out on its own, in order:
        // a program that flips quickly (a voice chat opening and closing a
        // stream) must not leave the frontend believing the older state.
        for msg in &batch {
            if let Msg::SessionState { pid, active } = msg {
                let payload = SessionActivity {
                    pid: *pid,
                    active: *active,
                };
                if let Err(e) = app.emit(SESSION_ACTIVITY_EVENT, &payload) {
                    warn!("could not deliver {SESSION_ACTIVITY_EVENT}: {e}");
                }
            }
        }
        if devices || sessions {
            sync(
                &enumerator,
                &session_client,
                &tx,
                &sounding,
                &mut watched_managers,
                &mut watched_sessions,
                &mut absences,
            );
            let changed = AudioChanged { devices, sessions };
            if let Err(e) = app.emit(AUDIO_CHANGED_EVENT, &changed) {
                warn!("could not deliver {AUDIO_CHANGED_EVENT}: {e}");
            }
        }
    }

    for (_, watched) in watched_sessions.drain() {
        // SAFETY: balances RegisterAudioSessionNotification above.
        unsafe {
            let _ = watched
                .control
                .UnregisterAudioSessionNotification(&watched.events);
        }
    }
    for (_, manager) in watched_managers.drain() {
        // SAFETY: balances RegisterSessionNotification above.
        unsafe {
            let _ = manager.UnregisterSessionNotification(&session_client);
        }
    }

    // SAFETY: balances the registration above; both objects are still owned here.
    unsafe {
        let _ = enumerator.UnregisterEndpointNotificationCallback(&endpoint_client);
    }
    crate::audio::uninit_com(com_owned);
}
