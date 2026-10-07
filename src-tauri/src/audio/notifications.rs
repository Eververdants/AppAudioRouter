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

use std::collections::{HashMap, HashSet};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};

use log::warn;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::core::{implement, Interface, GUID, PCWSTR};
use windows::Win32::Foundation::BOOL;
use windows::Win32::Media::Audio::{
    eRender, AudioSessionDisconnectReason, AudioSessionState, AudioSessionStateActive,
    AudioSessionStateExpired, AudioSessionStateInactive, EDataFlow, ERole, IAudioSessionControl,
    IAudioSessionControl2, IAudioSessionEnumerator, IAudioSessionEvents, IAudioSessionEvents_Impl,
    IAudioSessionManager2, IAudioSessionNotification, IAudioSessionNotification_Impl, IMMDevice,
    IMMDeviceEnumerator, IMMNotificationClient, IMMNotificationClient_Impl, MMDeviceEnumerator,
    DEVICE_STATE, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL};
use windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY;

/// Event carrying an [`AudioChanged`] payload.
pub const AUDIO_CHANGED_EVENT: &str = "audio-changed";

/// Event carrying a [`SessionActivity`] payload.
pub const SESSION_ACTIVITY_EVENT: &str = "session-activity";

/// Which half of the frontend is stale.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioChanged {
    /// The endpoint list, or the system default among them, moved.
    pub devices: bool,
    /// A session appeared or expired.
    pub sessions: bool,
}

/// One process began or stopped rendering audio.
///
/// Emitted on its own channel rather than folded into [`AudioChanged`]: a
/// session going quiet is not a list change (the session survives), and the
/// frontend uses this to animate the routes of the programs that are actually
/// sounding — which wants to arrive now, not at the end of a re-enumeration.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionActivity {
    /// The process whose audio state moved.
    pub pid: u32,
    /// Whether it is rendering audio now.
    pub active: bool,
}

/// Work item handed from a COM callback thread back to the owner thread.
enum Msg {
    /// An endpoint changed: its device is new, gone, or the new default.
    Endpoint,
    /// A session appeared on a device this thread watches.
    SessionCreated,
    /// A watched session expired (the app stopped playing or exited).
    SessionExpired,
    /// A watched session began or stopped rendering audio.
    SessionState { pid: u32, active: bool },
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

/// Registered on every session to learn when it expires or changes state.
///
/// `RegisterSessionNotification` only reports *new* sessions, so without this
/// the process list would keep showing apps that stopped playing long ago, and
/// nothing would say when a listed app actually began or stopped sounding.
/// The PID is captured at registration because the state callback itself
/// carries no identity — the event has to name the process it is about.
#[implement(IAudioSessionEvents)]
struct SessionEvents {
    tx: Sender<Msg>,
    /// Process the watched session belongs to; `0` when it could not be read,
    /// in which case state events are dropped (expiry still works).
    pid: u32,
    /// Which session this object watches, as the ledger below keys it. One
    /// process holds a session per endpoint it plays to, and the callback does
    /// not say which one moved.
    session_id: String,
    /// Every session of every process this thread is watching that is playing
    /// right now, so a transition can be reported as the process's own.
    sounding: Sounding,
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
type Sounding = Arc<Mutex<HashMap<u32, HashSet<String>>>>;

/// Record one session's state and report whether the process as a whole flipped.
///
/// `None` means the process was already answering that way, which is the common
/// case for a program with several sessions and the reason this returns a
/// decision rather than sending the message itself.
fn note_session_state(
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
fn forget_session(sounding: &Sounding, session_id: &str) {
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
struct WatchedSession {
    control: IAudioSessionControl,
    events: IAudioSessionEvents,
    /// Which endpoint the session lives on, so a sync that could not read one
    /// device's session list still prunes the stale watchers the *other*
    /// devices are known to have lost.
    device_id: String,
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
    // These maps are also the owners that keep the COM registrations alive.
    let mut watched_managers: HashMap<String, IAudioSessionManager2> = HashMap::new();
    let mut watched_sessions: HashMap<String, WatchedSession> = HashMap::new();
    // Which sessions are playing, so a state callback about one session can be
    // reported as a change of its process. Shared with the callback objects,
    // which Windows invokes on its own threads.
    let sounding: Sounding = Arc::new(Mutex::new(HashMap::new()));

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

/// Wire the session watcher onto every active render device and the expiry
/// watcher onto every session, dropping registrations that no longer exist.
fn sync(
    enumerator: &IMMDeviceEnumerator,
    session_client: &IAudioSessionNotification,
    tx: &Sender<Msg>,
    sounding: &Sounding,
    watched_managers: &mut HashMap<String, IAudioSessionManager2>,
    watched_sessions: &mut HashMap<String, WatchedSession>,
) {
    let Ok(devices) = active_render_devices(enumerator) else {
        return;
    };

    let mut live_devices: HashSet<String> = HashSet::new();
    let mut live_sessions: HashSet<String> = HashSet::new();
    // The endpoints whose session list this pass read to the end. Pruning is
    // only honest against a complete walk, but it has to be decided *per
    // endpoint*: one device that will not activate — a DisplayPort sink the
    // audio service refuses, a shared-mode exclusive device — used to switch
    // pruning off for every device, for the rest of the run. Each watcher then
    // held two COM references and a channel sender for a session that had
    // already expired, and every expiry it still reported provoked another full
    // re-enumeration.
    let mut walked: HashSet<String> = HashSet::new();

    for device in &devices {
        live_devices.insert(device.id.clone());

        let manager = match watched_managers.get(&device.id) {
            Some(manager) => manager.clone(),
            None => {
                let manager = match open_session_manager(&device.raw) {
                    Ok(manager) => manager,
                    Err(_) => continue,
                };

                // SAFETY: manager and session_client are owned and used on this
                // one notification thread. The manager is kept in the map below,
                // which is what keeps this registration alive between syncs.
                match unsafe { manager.RegisterSessionNotification(session_client) } {
                    Ok(()) => {
                        watched_managers.insert(device.id.clone(), manager.clone());
                    }
                    Err(e) => warn!("could not watch sessions on {}: {e}", device.id),
                }
                manager
            }
        };

        match sessions_of(&manager) {
            Some(sessions) => {
                walked.insert(device.id.clone());
                for session in sessions {
                    let id = session_identifier(&session);
                    if id.is_empty() {
                        continue;
                    }
                    // Every session that exists is accounted for, whether or not
                    // this pass is the one that registered its watcher — the
                    // prune below compares against exactly this set.
                    live_sessions.insert(id.clone());
                    if watched_sessions.contains_key(&id) {
                        continue;
                    }
                    // SAFETY: GetProcessId on the session control this thread
                    // just enumerated and owns.
                    let pid = unsafe { session.GetProcessId() }.unwrap_or(0);
                    let events: IAudioSessionEvents = SessionEvents {
                        tx: tx.clone(),
                        // Read here, on the owner thread, while the control is
                        // in hand: the state callback has no identity of its
                        // own to report. `0` reads as "unknown" and only costs
                        // the liveness events, never the expiry ones.
                        pid,
                        session_id: id.clone(),
                        sounding: Arc::clone(sounding),
                    }
                    .into();
                    let Ok(control) = session.cast::<IAudioSessionControl>() else {
                        continue;
                    };
                    // SAFETY: the callback and the control are kept alive in
                    // watched_sessions, so this registration remains valid until
                    // we unregister it during a prune or thread teardown.
                    if unsafe { session.RegisterAudioSessionNotification(&events) }.is_ok() {
                        // Seed the ledger with the state as it stands. The
                        // frontend learns the same fact from the list it is
                        // about to enumerate, and an unseeded ledger would read
                        // this session's first pause as "nothing changed" —
                        // leaving a program that fell silent drawn as sounding.
                        if pid != 0 {
                            // SAFETY: the session control is the one just read.
                            let state =
                                unsafe { session.GetState() }.unwrap_or(AudioSessionStateInactive);
                            note_session_state(
                                sounding,
                                pid,
                                &id,
                                state == AudioSessionStateActive,
                            );
                        }
                        watched_sessions.insert(
                            id.clone(),
                            WatchedSession {
                                control,
                                events,
                                device_id: device.id.clone(),
                            },
                        );
                    }
                }
            }
            None => {}
        }
    }

    prune_watchers(
        session_client,
        sounding,
        watched_managers,
        watched_sessions,
        &live_devices,
        &live_sessions,
        &walked,
    );
}

/// Drop watchers for devices and sessions that no longer exist, unregistering
/// each COM callback before its owning interface is released, and forget each
/// dropped session in the liveness ledger.
///
/// A watcher whose endpoint this pass could not walk is kept: its sessions are
/// missing from `live_sessions` because the walk failed, not because they went
/// away, and unregistering on that reading would drop callbacks for sessions
/// that are still playing.
fn prune_watchers(
    session_client: &IAudioSessionNotification,
    sounding: &Sounding,
    watched_managers: &mut HashMap<String, IAudioSessionManager2>,
    watched_sessions: &mut HashMap<String, WatchedSession>,
    live_devices: &HashSet<String>,
    live_sessions: &HashSet<String>,
    walked: &HashSet<String>,
) {
    watched_managers.retain(|id, manager| {
        if live_devices.contains(id) {
            return true;
        }
        // SAFETY: balances the registration recorded in this map.
        unsafe {
            let _ = manager.UnregisterSessionNotification(session_client);
        }
        false
    });
    watched_sessions.retain(|id, watched| {
        let keep = if live_sessions.contains(id) {
            true
        } else if !live_devices.contains(&watched.device_id) {
            // The endpoint itself is gone, so everything on it went with it.
            false
        } else {
            !walked.contains(&watched.device_id)
        };
        if keep {
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
        let device = (unsafe { collection.Item(i) }).map_err(|_| ())?;
        // SAFETY: GetId returns a PWSTR copied out and freed below.
        let pwstr = (unsafe { device.GetId() }).map_err(|_| ())?;
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
