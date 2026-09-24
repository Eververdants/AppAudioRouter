//! Core Audio change notifications.
//!
//! Pushes `audio-changed` events at the frontend so the device and process
//! lists follow reality — a headset plugged in, an app that starts or stops
//! playing — without a polling timer touching the audio engine while idle.
//!
//! Every COM pointer in this module belongs to **one** thread. [`start`] spawns
//! a dedicated MTA thread that registers the callbacks and then owns them for
//! the rest of the process. windows-rs interfaces are neither `Send` nor `Sync`,
//! so confining them to one thread is what lets this module avoid
//! `unsafe impl Send` workarounds entirely: the callbacks, which Windows invokes
//! on its own RPC threads, do nothing but drop a message in a channel.

use std::collections::HashSet;
use std::sync::mpsc::{channel, Sender};

use log::warn;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::core::{implement, Interface, GUID, PCWSTR};
use windows::Win32::Foundation::BOOL;
use windows::Win32::Media::Audio::{
    eRender, AudioSessionDisconnectReason, AudioSessionState, AudioSessionStateExpired, EDataFlow,
    ERole, IAudioSessionControl, IAudioSessionControl2, IAudioSessionEnumerator,
    IAudioSessionEvents, IAudioSessionEvents_Impl, IAudioSessionManager2,
    IAudioSessionNotification, IAudioSessionNotification_Impl, IMMDevice, IMMDeviceEnumerator,
    IMMNotificationClient, IMMNotificationClient_Impl, MMDeviceEnumerator, DEVICE_STATE,
    DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL};
use windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY;

/// Event carrying an [`AudioChanged`] payload.
pub const AUDIO_CHANGED_EVENT: &str = "audio-changed";

/// Which half of the frontend is stale.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioChanged {
    /// The endpoint list, or the system default among them, moved.
    pub devices: bool,
    /// A session appeared or expired.
    pub sessions: bool,
}

/// Work item handed from a COM callback thread back to the owner thread.
enum Msg {
    /// An endpoint changed: its device is new, gone, or the new default.
    Endpoint,
    /// A session appeared on a device this thread watches.
    SessionCreated,
    /// A watched session expired (the app stopped playing or exited).
    SessionExpired,
}

/// Registered with `IMMDeviceEnumerator::RegisterEndpointNotificationCallback`.
#[implement(IMMNotificationClient)]
struct EndpointWatcher {
    tx: Sender<Msg>,
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
struct SessionWatcher {
    tx: Sender<Msg>,
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

/// Registered on every session to learn when it expires.
///
/// `RegisterSessionNotification` only reports *new* sessions, so without this the
/// process list would keep showing apps that stopped playing long ago.
#[implement(IAudioSessionEvents)]
struct SessionEvents {
    tx: Sender<Msg>,
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
        // the session survives — is deliberately ignored: that app is still
        // routable and must stay listed.
        if new_state == AudioSessionStateExpired {
            let _ = self.tx.send(Msg::SessionExpired);
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
    let mut watched_devices: HashSet<String> = HashSet::new();
    let mut watched_sessions: HashSet<String> = HashSet::new();

    // Wire the session watchers onto the graph as it already is. Both callbacks
    // only ever report *changes*, so without this pass a session that started
    // before the app launched would never be watched, and no event would arrive
    // for it until an endpoint changed. The frontend enumerates on its own at
    // startup, which is why this pass reports nothing.
    sync(
        &enumerator,
        &session_client,
        &tx,
        &mut watched_devices,
        &mut watched_sessions,
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
            }
        }
        sync(
            &enumerator,
            &session_client,
            &tx,
            &mut watched_devices,
            &mut watched_sessions,
        );
        let changed = AudioChanged { devices, sessions };
        if let Err(e) = app.emit(AUDIO_CHANGED_EVENT, &changed) {
            warn!("could not deliver {AUDIO_CHANGED_EVENT}: {e}");
        }
    }

    // SAFETY: balances the registration above; both objects are still owned here.
    unsafe {
        let _ = enumerator.UnregisterEndpointNotificationCallback(&endpoint_client);
    }
    crate::audio::uninit_com(com_owned);
}

/// Wire the session watcher onto every active render device and the expiry
/// watcher onto every session, dropping registrations that no longer exist.
fn sync(
    enumerator: &IMMDeviceEnumerator,
    session_client: &IAudioSessionNotification,
    tx: &Sender<Msg>,
    watched_devices: &mut HashSet<String>,
    watched_sessions: &mut HashSet<String>,
) {
    let Ok(devices) = active_render_devices(enumerator) else {
        return;
    };

    let mut live_devices: HashSet<String> = HashSet::new();
    let mut live_sessions: HashSet<String> = HashSet::new();
    // Pruning is only honest against a complete walk. If one device's manager
    // cannot be opened, its sessions are missing from `live_sessions`, and
    // pruning then would forget watchers that are still registered — the next
    // sync would register a second one for the same session.
    let mut complete = true;

    for device in &devices {
        live_devices.insert(device.id.clone());

        let manager = match open_session_manager(&device.raw) {
            Ok(manager) => manager,
            Err(_) => {
                complete = false;
                continue;
            }
        };

        if !watched_devices.contains(&device.id) {
            // SAFETY: `manager` is live and `session_client` outlives it — both
            // are owned by this thread, and the client is unregistered with the
            // device itself when it disappears.
            match unsafe { manager.RegisterSessionNotification(session_client) } {
                Ok(()) => {
                    watched_devices.insert(device.id.clone());
                }
                Err(e) => warn!("could not watch sessions on {}: {e}", device.id),
            }
        }

        match sessions_of(&manager) {
            Some(sessions) => {
                for session in sessions {
                    let id = session_identifier(&session);
                    if id.is_empty() {
                        continue;
                    }
                    // Every session that exists is accounted for, whether or not
                    // this pass is the one that registered its watcher — the
                    // prune below compares against exactly this set.
                    live_sessions.insert(id.clone());
                    if watched_sessions.contains(&id) {
                        continue;
                    }
                    let events: IAudioSessionEvents = SessionEvents { tx: tx.clone() }.into();
                    // SAFETY: the callback is kept alive by `watched_sessions`'
                    // bookkeeping on this thread, and the session is alive here.
                    if unsafe { session.RegisterAudioSessionNotification(&events) }.is_ok() {
                        watched_sessions.insert(id);
                    }
                }
            }
            None => complete = false,
        }
    }

    if complete {
        watched_devices.retain(|id| live_devices.contains(id));
        watched_sessions.retain(|id| live_sessions.contains(id));
    }
}

/// One active render endpoint: its id (for the watch lists) and its interface.
struct DeviceRef {
    id: String,
    raw: IMMDevice,
}

/// Enumerate active render endpoints with their ids.
fn active_render_devices(enumerator: &IMMDeviceEnumerator) -> Result<Vec<DeviceRef>, ()> {
    // SAFETY: eRender + DEVICE_STATE_ACTIVE are valid params.
    let Ok(collection) = (unsafe { enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) })
    else {
        return Err(());
    };
    let Ok(count) = (unsafe { collection.GetCount() }) else {
        return Err(());
    };
    let mut devices = Vec::with_capacity(count as usize);
    for i in 0..count {
        // SAFETY: i is within [0, count).
        let Ok(device) = (unsafe { collection.Item(i) }) else {
            continue;
        };
        // SAFETY: GetId returns a PWSTR copied out and freed below.
        let Ok(pwstr) = (unsafe { device.GetId() }) else {
            continue;
        };
        let id = crate::audio::pwstr_to_string(&pwstr);
        // SAFETY: balances GetId's allocation.
        unsafe { CoTaskMemFree(Some(pwstr.0 as *const _)) };
        devices.push(DeviceRef { id, raw: device });
    }
    Ok(devices)
}

/// Activate the session manager of one device.
fn open_session_manager(device: &IMMDevice) -> Result<IAudioSessionManager2, ()> {
    // SAFETY: activating IAudioSessionManager2 on an active render device.
    unsafe { device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) }.map_err(|_| ())
}

/// Every session of one device, or `None` when the enumerator is unavailable.
fn sessions_of(manager: &IAudioSessionManager2) -> Option<Vec<IAudioSessionControl2>> {
    // SAFETY: GetSessionEnumerator on a live session manager.
    let session_enum: IAudioSessionEnumerator = unsafe { manager.GetSessionEnumerator() }.ok()?;
    let count = unsafe { session_enum.GetCount() }.ok()?;
    let mut sessions = Vec::with_capacity(count as usize);
    for i in 0..count {
        // SAFETY: i is within [0, count).
        let Ok(control) = (unsafe { session_enum.GetSession(i) }) else {
            continue;
        };
        if let Ok(control2) = control.cast::<IAudioSessionControl2>() {
            sessions.push(control2);
        }
    }
    Some(sessions)
}

/// A session's unique identifier, or an empty string when it cannot be read.
fn session_identifier(session: &IAudioSessionControl2) -> String {
    // SAFETY: GetSessionIdentifier returns a PWSTR copied out and freed below.
    let Ok(pwstr) = (unsafe { session.GetSessionIdentifier() }) else {
        return String::new();
    };
    let id = crate::audio::pwstr_to_string(&pwstr);
    // SAFETY: balances GetSessionIdentifier's allocation.
    unsafe { CoTaskMemFree(Some(pwstr.0 as *const _)) };
    id
}
