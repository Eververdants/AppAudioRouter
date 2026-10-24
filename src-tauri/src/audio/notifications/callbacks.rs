//! The three COM callback objects Windows invokes on its own threads, the
//! liveness ledger they write, and the record of a registered watcher.
//!
//! Each callback is registered once by [`super::thread`] and owns nothing but a
//! `Sender` back to the thread that does own the COM pointers: an endpoint
//! change, a new session, or a state flip becomes a message and nothing else,
//! so no interface ever crosses a thread boundary here. The two session-side
//! callbacks are distinct on purpose — `IAudioSessionNotification` reports only
//! *created* sessions, `IAudioSessionEvents::OnStateChanged` reports both death
//! and audio activity, and `Inactive` (paused but alive) is never an exit.

use std::collections::{HashMap, HashSet};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

use windows::core::{implement, GUID, PCWSTR};
use windows::Win32::Foundation::BOOL;
use windows::Win32::Media::Audio::{
    eRender, AudioSessionDisconnectReason, AudioSessionState, AudioSessionStateActive,
    AudioSessionStateExpired, AudioSessionStateInactive, EDataFlow, ERole, IAudioSessionControl,
    IAudioSessionEvents, IAudioSessionEvents_Impl, IAudioSessionNotification,
    IAudioSessionNotification_Impl, IMMNotificationClient, IMMNotificationClient_Impl,
    DEVICE_STATE,
};
use windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY;

use super::Msg;

/// Registered with `IMMDeviceEnumerator::RegisterEndpointNotificationCallback`.
#[implement(IMMNotificationClient)]
pub(super) struct EndpointWatcher {
    pub(super) tx: Sender<Msg>,
}

// Implemented on the macro-generated wrapper (`Deref`s to `EndpointWatcher`),
// which is what the vtable shim requires in windows 0.58.
impl IMMNotificationClient_Impl for EndpointWatcher_Impl {
    fn OnDeviceStateChanged(
        &self,
        _device_id: &PCWSTR,
        _new_state: DEVICE_STATE,
    ) -> windows::core::Result<()> {
        let _ = self.tx.send(Msg::Endpoint);
        Ok(())
    }

    fn OnDeviceAdded(&self, _device_id: &PCWSTR) -> windows::core::Result<()> {
        let _ = self.tx.send(Msg::Endpoint);
        Ok(())
    }

    fn OnDeviceRemoved(&self, _device_id: &PCWSTR) -> windows::core::Result<()> {
        let _ = self.tx.send(Msg::Endpoint);
        Ok(())
    }

    fn OnDefaultDeviceChanged(
        &self,
        flow: EDataFlow,
        _role: ERole,
        _device_id: &PCWSTR,
    ) -> windows::core::Result<()> {
        // Capture endpoints are not routable here, and their default moving
        // would otherwise provoke a pointless re-enumeration.
        if flow == eRender {
            let _ = self.tx.send(Msg::Endpoint);
        }
        Ok(())
    }

    fn OnPropertyValueChanged(
        &self,
        _device_id: &PCWSTR,
        _key: &PROPERTYKEY,
    ) -> windows::core::Result<()> {
        // Friendly-name and category edits land here; the list shows names.
        let _ = self.tx.send(Msg::Endpoint);
        Ok(())
    }
}

/// Registered once per render device with `RegisterSessionNotification`.
#[implement(IAudioSessionNotification)]
pub(super) struct SessionWatcher {
    pub(super) tx: Sender<Msg>,
}

impl IAudioSessionNotification_Impl for SessionWatcher_Impl {
    /// The new session control arrives with this callback, but acting on it here
    /// would mean using a COM pointer from a thread that does not own it, so the
    /// owner thread enumerates and registers instead.
    fn OnSessionCreated(
        &self,
        _new_session: Option<&IAudioSessionControl>,
    ) -> windows::core::Result<()> {
        let _ = self.tx.send(Msg::SessionCreated);
        Ok(())
    }
}

/// Registered on every session to learn when it expires or changes state.
///
/// `RegisterSessionNotification` only reports *new* sessions, so without this
/// the process list would keep showing apps that stopped playing long ago, and
/// nothing would say when a listed app actually began or stopped sounding.
/// The PID is captured at registration because the state callback itself
/// carries no identity — the event has to name the process it is about.
#[implement(IAudioSessionEvents)]
pub(super) struct SessionEvents {
    pub(super) tx: Sender<Msg>,
    /// Process the watched session belongs to; `0` when it could not be read,
    /// in which case state events are dropped (expiry still works).
    pub(super) pid: u32,
    /// Which session this object watches, as the ledger below keys it. One
    /// process holds a session per endpoint it plays to, and the callback does
    /// not say which one moved.
    pub(super) session_id: String,
    /// Every session of every process this thread is watching that is playing
    /// right now, so a transition can be reported as the process's own.
    pub(super) sounding: Sounding,
}

/// What each process is doing right now, as `pid -> the sessions of it that are
/// playing`.
///
/// `OnStateChanged` reports one *session*, but everything the frontend spends it
/// on — the flowing wire, the pulsing ring, the "播放中" count — is about the
/// process, and one process holds a session per endpoint it renders to. Passing
/// the raw transition through let a browser that paused one tab read as silent
/// while another tab was still playing, and nothing corrected it until the next
/// re-enumeration. The ledger turns per-session news into per-process news: a
/// message goes out only when the process's own answer changes.
pub(super) type Sounding = Arc<Mutex<HashMap<u32, HashSet<String>>>>;

/// Record one session's state and report whether the process as a whole flipped.
///
/// `None` means the process was already answering that way, which is the common
/// case for a program with several sessions and the reason this returns a
/// decision rather than sending the message itself.
pub(super) fn note_session_state(
    sounding: &Sounding,
    pid: u32,
    session_id: &str,
    active: bool,
) -> Option<bool> {
    let mut sounding = sounding.lock().unwrap_or_else(|e| e.into_inner());
    let sessions = sounding.entry(pid).or_default();
    let was = !sessions.is_empty();
    if active {
        sessions.insert(session_id.to_string());
    } else {
        sessions.remove(session_id);
    }
    let now = !sessions.is_empty();
    if !now {
        // Nothing playing is nothing to remember, and the key is a PID — which
        // Windows hands out again to somebody else.
        sounding.remove(&pid);
    }
    (was != now).then_some(now)
}

/// Forget a session that went away. Its process's answer may change with it,
/// and a stale entry would keep that process drawn as sounding for good.
pub(super) fn forget_session(sounding: &Sounding, session_id: &str) {
    let mut sounding = sounding.lock().unwrap_or_else(|e| e.into_inner());
    for sessions in sounding.values_mut() {
        sessions.remove(session_id);
    }
    sounding.retain(|_, sessions| !sessions.is_empty());
}

impl IAudioSessionEvents_Impl for SessionEvents_Impl {
    fn OnDisplayNameChanged(
        &self,
        _name: &PCWSTR,
        _event_context: *const GUID,
    ) -> windows::core::Result<()> {
        Ok(())
    }

    fn OnIconPathChanged(
        &self,
        _path: &PCWSTR,
        _event_context: *const GUID,
    ) -> windows::core::Result<()> {
        Ok(())
    }

    fn OnSimpleVolumeChanged(
        &self,
        _volume: f32,
        _mute: BOOL,
        _event_context: *const GUID,
    ) -> windows::core::Result<()> {
        Ok(())
    }

    fn OnChannelVolumeChanged(
        &self,
        _channel_count: u32,
        _volumes: *const f32,
        _changed_channel: u32,
        _event_context: *const GUID,
    ) -> windows::core::Result<()> {
        Ok(())
    }

    fn OnGroupingParamChanged(
        &self,
        _grouping: *const GUID,
        _event_context: *const GUID,
    ) -> windows::core::Result<()> {
        Ok(())
    }

    fn OnStateChanged(&self, new_state: AudioSessionState) -> windows::core::Result<()> {
        // `Expired` is the session going away. `Inactive` — playback stopped but
        // the session survives — is deliberately *not* treated as expiry: that
        // app is still routable and must stay listed. It is however exactly the
        // transition the frontend's liveness display wants, so both state
        // changes are forwarded on their own channel while the list is left
        // alone. (These states are constants rather than enum variants in the
        // bindings, so equality reads better than a match here anyway.)
        if new_state == AudioSessionStateExpired {
            let _ = self.tx.send(Msg::SessionExpired);
        } else if self.pid != 0
            && (new_state == AudioSessionStateActive || new_state == AudioSessionStateInactive)
        {
            let active = new_state == AudioSessionStateActive;
            // Reported as the process's own change, and only when its answer
            // actually moved: one of a browser's tabs going quiet says nothing
            // about the others.
            if let Some(now) =
                note_session_state(&self.sounding, self.pid, &self.session_id, active)
            {
                let _ = self.tx.send(Msg::SessionState {
                    pid: self.pid,
                    active: now,
                });
            }
        }
        Ok(())
    }

    fn OnSessionDisconnected(
        &self,
        _reason: AudioSessionDisconnectReason,
    ) -> windows::core::Result<()> {
        // Every disconnect reason also moves an endpoint, which is reported.
        Ok(())
    }
}

/// One registered session watcher.
///
/// Both COM interfaces are retained for as long as the watcher is active:
/// the control keeps the registration authoritative, and the event object is
/// what the session manager AddRef'd and must later release through
/// `UnregisterAudioSessionNotification`.
pub(super) struct WatchedSession {
    pub(super) control: IAudioSessionControl,
    pub(super) events: IAudioSessionEvents,
    /// Which endpoint the session lives on, so a sync that could not read one
    /// device's session list still prunes the stale watchers the *other*
    /// devices are known to have lost.
    pub(super) device_id: String,
}
