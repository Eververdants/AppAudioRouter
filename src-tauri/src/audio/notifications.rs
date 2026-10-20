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
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use log::warn;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::core::{implement, Interface, GUID, HRESULT, PCWSTR};
use windows::Win32::Foundation::BOOL;
use windows::Win32::Media::Audio::{
    eRender, AudioSessionDisconnectReason, AudioSessionState, AudioSessionStateActive,
    AudioSessionStateExpired, AudioSessionStateInactive, EDataFlow, ERole, IAudioSessionControl,
    IAudioSessionControl2, IAudioSessionEnumerator, IAudioSessionEvents, IAudioSessionEvents_Impl,
    IAudioSessionManager2, IAudioSessionNotification, IAudioSessionNotification_Impl, IMMDevice,
    IMMDeviceEnumerator, IMMNotificationClient, IMMNotificationClient_Impl, MMDeviceEnumerator,
    AUDCLNT_E_DEVICE_INVALIDATED, DEVICE_STATE, DEVICE_STATE_ACTIVE,
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

/// How many incomplete passes one endpoint that cannot be asked about may ride
/// on before its absence is accepted.
const MAX_DEFERRED_ABSENCE_PASSES: u32 = 5;
/// The monotonic-clock bound on the same deferral, for a graph that changes
/// slowly enough that the pass count never gets there first.
const DEFERRED_ABSENCE_GRACE_MS: u64 = 60_000;

/// A monotonic clock in milliseconds, for bounding a deferral.
///
/// `Instant` and not the wall clock: an NTP correction, or the machine waking
/// from sleep, must not lengthen or shorten how long a watcher may be deferred.
fn clock_ms() -> u64 {
    static ANCHOR: OnceLock<Instant> = OnceLock::new();
    ANCHOR.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// One endpoint this thread still holds watchers on but a walk did not name.
#[derive(Clone, Copy)]
struct DeferredAbsence {
    /// Incomplete passes this absence has ridden on, the current one included.
    passes: u32,
    /// When it was first suspected, in [`clock_ms`] units.
    since_ms: u64,
}

/// Bookkeeping for endpoint absences a partial walk cannot prove.
///
/// A walk that skipped an entry cannot tell a skipped endpoint from a removed
/// one. Pruning on that reading unregisters watchers of sessions that are still
/// playing, so the correction is to defer — but a deferral with no end is the
/// same bug turned slow: with one permanently flaky endpoint no later pass is
/// ever complete, and the session manager of a device that left weeks ago keeps
/// its COM registration, along with every session watcher on it and their slots
/// in the liveness ledger, for the rest of the run. So an absence is *asked
/// about* (see [`endpoint_probe`]): an answer of gone or live ends the
/// deferral on the spot, and only an endpoint that cannot be asked at all is
/// deferred, and only under a bound.
#[derive(Default)]
struct AbsenceLedger {
    deferred: HashMap<String, DeferredAbsence>,
}

impl AbsenceLedger {
    /// Forget the endpoints that this pass named again, or that no watcher is
    /// held on any more.
    fn sweep(&mut self, named: &HashSet<String>, watched: &HashSet<String>) {
        self.deferred
            .retain(|id, _| !named.contains(id) && watched.contains(id));
    }

    /// Whether one endpoint the walk skipped may keep its watchers this pass.
    ///
    /// `answer` is the audio service's own reading of that exact id (see
    /// [`endpoint_probe`]). An endpoint it no longer resolves, or resolves to
    /// something it does not call active, is gone and the absence is accepted at
    /// once. An endpoint it calls active keeps its watchers however often the
    /// walk fails to name it: it is handed back and walked on every one of those
    /// passes, so its expired sessions are still pruned and nothing accumulates.
    /// Only an endpoint that cannot be asked at all rides on at most
    /// [`MAX_DEFERRED_ABSENCE_PASSES`] passes or
    /// [`DEFERRED_ABSENCE_GRACE_MS`] of monotonic clock, whichever comes first —
    /// a question this thread can never get an answer to must not hold a
    /// registration for the rest of the run either.
    fn tolerate(&mut self, id: &str, answer: EndpointAnswer, now_ms: u64) -> bool {
        if answer != EndpointAnswer::Unproven {
            self.deferred.remove(id);
            return answer == EndpointAnswer::Live;
        }
        let entry = self
            .deferred
            .entry(id.to_string())
            .or_insert(DeferredAbsence {
                passes: 0,
                since_ms: now_ms,
            });
        entry.passes += 1;
        let overdue = entry.passes >= MAX_DEFERRED_ABSENCE_PASSES
            || now_ms.saturating_sub(entry.since_ms) >= DEFERRED_ABSENCE_GRACE_MS;
        if overdue {
            self.deferred.remove(id);
            return false;
        }
        true
    }
}

/// The endpoints this thread holds watchers on: every session manager it
/// registered, plus the device of every session watcher it holds.
///
/// Both halves are needed: a manager whose `RegisterSessionNotification` was
/// refused is not in the map, yet its sessions are still watched, and a device
/// that left with its sessions behind would otherwise go unprobed.
fn watched_device_ids(
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

/// What the audio service's own answer about one exact endpoint id means.
///
/// Only [`EndpointAnswer::Gone`] proves an absence and only
/// [`EndpointAnswer::Live`] disproves one; [`EndpointAnswer::Unproven`] keeps the
/// question open for a bounded number of passes (see [`AbsenceLedger`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EndpointAnswer {
    /// The service names this endpoint and calls it active: the walk failed to
    /// read it, it did not go away.
    Live,
    /// The service no longer resolves this id, or resolves it to an endpoint it
    /// does not call active (unplugged, disabled, or removed from the store).
    Gone,
    /// The question could not be asked: a transient service failure says nothing
    /// about whether this endpoint is there.
    Unproven,
}

/// Whether the service's own answer about an id means that endpoint is gone.
///
/// `AUDCLNT_E_DEVICE_INVALIDATED` is what `GetDevice` returns for an id the
/// device store no longer resolves. Codes that mean "the service could not be
/// talked to just now" — a disconnected RPC channel, an out-of-memory in
/// AudioSrv, an uninitialized apartment — are deliberately *not* absence: an
/// endpoint read as gone on such a failure loses its session-manager and session
/// watchers, and because the walk is what normally re-registers them, an
/// endpoint the walk keeps failing to name would stay unwatched for the rest of
/// the run. That is the blindness this module exists to avoid.
fn lookup_denotes_absence(code: HRESULT) -> bool {
    code == AUDCLNT_E_DEVICE_INVALIDATED
}

/// Whether the service calls this endpoint an active one.
///
/// The same reading the enumeration walk filters on (`DEVICE_STATE_ACTIVE`), so
/// an endpoint the store still keeps but has unplugged or disabled answers the
/// absence question the way a vanished id does instead of riding on a bound.
fn endpoint_is_active(state: DEVICE_STATE) -> bool {
    state.0 & DEVICE_STATE_ACTIVE.0 != 0
}

/// Ask the audio service about one endpoint by its exact id.
///
/// Along with the answer it returns the endpoint itself — only for
/// [`EndpointAnswer::Live`], so a pass whose walk could not read that entry can
/// still watch a device that is demonstrably there.
fn endpoint_probe(
    enumerator: &IMMDeviceEnumerator,
    id: &str,
) -> (EndpointAnswer, Option<DeviceRef>) {
    let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: `wide` is NUL-terminated and outlives the call; GetDevice copies
    // the id it needs before returning.
    let device = match unsafe { enumerator.GetDevice(PCWSTR(wide.as_ptr())) } {
        Ok(device) => device,
        Err(e) => {
            if lookup_denotes_absence(e.code()) {
                return (EndpointAnswer::Gone, None);
            }
            warn!("endpoint {id} could not be asked whether it is there: {e}");
            return (EndpointAnswer::Unproven, None);
        }
    };
    // SAFETY: GetState on the device this thread just obtained and owns.
    let state = match unsafe { device.GetState() } {
        Ok(state) => state,
        Err(e) => {
            // Known, but not known to be active: no evidence either way, so the
            // deferral survives under its own bound rather than being read as a
            // removal.
            warn!("endpoint {id} could not be asked its state: {e}");
            return (EndpointAnswer::Unproven, None);
        }
    };
    if endpoint_is_active(state) {
        (
            EndpointAnswer::Live,
            Some(DeviceRef {
                id: id.to_string(),
                raw: device,
            }),
        )
    } else {
        (EndpointAnswer::Gone, None)
    }
}

/// Whether a watched session reports itself gone.
///
/// Only asked of watchers a pass could not account for any other way, so the
/// cost is bounded by how many of them there are — normally none. A state that
/// cannot be read is no evidence either way and keeps the watcher.
fn session_self_reports_gone(watched: &WatchedSession) -> bool {
    // SAFETY: GetState on a session control this thread registered and owns.
    matches!(
        unsafe { watched.control.GetState() },
        Ok(state) if state == AudioSessionStateExpired
    )
}

/// What one synchronisation pass proved is still there.
///
/// The four sets travel together because the prune needs all of them to answer
/// one question — may this watcher still exist? — and a pass that read half the
/// graph can only ever answer it in degrees.
#[derive(Clone, Default)]
struct Witness {
    /// Endpoints this pass can account for: named by the walk, or skipped by it
    /// and kept by [`AbsenceLedger`] after being asked about by that exact id.
    devices: HashSet<String>,
    /// Sessions named by a session list that was read to the end.
    sessions: HashSet<String>,
    /// Endpoints whose session list this pass read to the end. A list with an
    /// entry that could not be read is *not* one of these: it names some of the
    /// device's sessions, which proves nothing about the rest.
    walked: HashSet<String>,
    /// Watched sessions that reported themselves expired.
    expired: HashSet<String>,
}

/// Whether one watched session survives this pass.
///
/// The four readings of an absent session id, in the order they are settled:
/// the walk saw it, so it lives; its endpoint is gone, so it went with it; it
/// reported itself expired; and only if none of that applies, the endpoint is
/// still accounted for but its session list was not read to the end, which
/// proves nothing.
fn keep_session_watcher(id: &str, device_id: &str, witness: &Witness) -> bool {
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

/// Wire the session watcher onto every active render device and the expiry
/// watcher onto every session, dropping registrations that no longer exist.
///
/// `absences` carries what this thread already knows about endpoints an earlier
/// pass could not name: each one is asked about by id, and only an endpoint the
/// service cannot be asked about at all defers its prune, and only under a bound.
/// See [`AbsenceLedger`].
fn sync(
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

/// One active render endpoint: its id (for the watch lists) and its interface.
struct DeviceRef {
    id: String,
    raw: IMMDevice,
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
fn active_render_devices(enumerator: &IMMDeviceEnumerator) -> Result<(Vec<DeviceRef>, bool), ()> {
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
fn open_session_manager(device: &IMMDevice) -> Result<IAudioSessionManager2, ()> {
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
fn sessions_of(manager: &IAudioSessionManager2) -> Option<(Vec<IAudioSessionControl2>, bool)> {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A device set from a list of ids.
    fn set(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|id| (*id).to_string()).collect()
    }

    /// An endpoint the audio service no longer resolves is gone on the spot.
    ///
    /// This is the case the deferral must never swallow: the watcher of a device
    /// that was pulled out keeps its COM registrations for the rest of the run,
    /// and its expired sessions keep their slots in the liveness ledger — where
    /// a PID a recycled process inherits keeps the new one drawn as sounding.
    #[test]
    fn a_device_that_answers_no_lookup_is_accepted_as_gone_at_once() {
        let mut ledger = AbsenceLedger::default();
        assert!(!ledger.tolerate("gone", EndpointAnswer::Gone, 0));
        assert!(ledger.deferred.is_empty());

        // And the next pass starts clean rather than counting towards a bound it
        // no longer needs.
        assert!(ledger.tolerate("flaky", EndpointAnswer::Unproven, 0));
        assert!(!ledger.tolerate("flaky", EndpointAnswer::Gone, 1));
        assert!(ledger.deferred.is_empty());
    }

    /// An endpoint the service still calls active is not on its way out, however
    /// often the walk fails to name it, and the bound must not say otherwise:
    /// the tolerated endpoint is handed back and walked on every one of those
    /// passes, so nothing accumulates — while a prune here would take its watchers
    /// away from a live device, and since the walk is what re-registers them, an
    /// endpoint the walk never names would never be watched again.
    #[test]
    fn a_live_endpoint_is_never_pruned_by_a_walk_that_cannot_read_it() {
        let mut ledger = AbsenceLedger::default();
        for pass in 0..3 * MAX_DEFERRED_ABSENCE_PASSES {
            assert!(
                ledger.tolerate("flaky", EndpointAnswer::Live, u64::from(pass) * 1_000),
                "pass {pass} of a walk that cannot read this entry still keeps it"
            );
        }
        // It leaves no trace behind either, so a failure that comes later starts
        // its own count instead of inheriting this one.
        assert!(ledger.deferred.is_empty());
    }

    /// The bound is for the endpoint that cannot be asked about at all: a
    /// question this thread never gets an answer to must not hold a registration
    /// for the rest of the run.
    #[test]
    fn an_endpoint_that_cannot_be_asked_is_deferred_only_a_bounded_number_of_times() {
        let mut ledger = AbsenceLedger::default();
        for pass in 1..MAX_DEFERRED_ABSENCE_PASSES {
            assert!(
                ledger.tolerate("mute", EndpointAnswer::Unproven, u64::from(pass)),
                "pass {pass} of an unanswered question still defers"
            );
        }
        assert!(
            !ledger.tolerate(
                "mute",
                EndpointAnswer::Unproven,
                u64::from(MAX_DEFERRED_ABSENCE_PASSES)
            ),
            "the bound ends the deferral when nothing else can"
        );
        assert!(ledger.deferred.is_empty());
    }

    /// The other half of the bound, for a graph that barely changes: five
    /// passes of a quiet session can be hours apart, and a deferred prune that
    /// waits that long is the leak with a longer fuse.
    #[test]
    fn the_deadline_ends_a_deferral_whatever_the_pass_count() {
        let mut ledger = AbsenceLedger::default();
        assert!(ledger.tolerate("mute", EndpointAnswer::Unproven, 0));
        assert!(ledger.tolerate("mute", EndpointAnswer::Unproven, 1_000));
        assert!(!ledger.tolerate("mute", EndpointAnswer::Unproven, DEFERRED_ABSENCE_GRACE_MS));
    }

    /// Being named again is the evidence that ends the suspicion, so a device
    /// that comes back cannot be pruned by a later pass on the strength of the
    /// passes it spent missing.
    #[test]
    fn naming_an_endpoint_again_clears_its_deferral() {
        let mut ledger = AbsenceLedger::default();
        assert!(ledger.tolerate("back", EndpointAnswer::Unproven, 0));
        assert!(ledger.tolerate("gone", EndpointAnswer::Unproven, 0));
        ledger.sweep(&set(&["back"]), &set(&["back", "gone"]));
        assert!(!ledger.deferred.contains_key("back"));
        assert!(ledger.deferred.contains_key("gone"));

        // A watcher that no longer exists stops being counted, too.
        ledger.sweep(&set(&[]), &set(&[]));
        assert!(ledger.deferred.is_empty());
    }

    /// Only the service's own "this id is no longer an endpoint" may end a
    /// deferral early. Every other failure — a disconnected RPC channel, an
    /// out-of-memory inside AudioSrv, an apartment that is not up yet — means the
    /// question could not be asked, and reading it as a removal would unregister
    /// the watchers of a device that is playing sound right now.
    #[test]
    fn a_busy_audio_service_is_not_evidence_that_an_endpoint_left() {
        use windows::Win32::Foundation::{CO_E_NOTINITIALIZED, E_OUTOFMEMORY, RPC_E_DISCONNECTED};
        use windows::Win32::Media::Audio::AUDCLNT_E_NOT_INITIALIZED;

        assert!(lookup_denotes_absence(AUDCLNT_E_DEVICE_INVALIDATED));
        for could_not_ask in [
            E_OUTOFMEMORY,
            RPC_E_DISCONNECTED,
            CO_E_NOTINITIALIZED,
            AUDCLNT_E_NOT_INITIALIZED,
        ] {
            assert!(
                !lookup_denotes_absence(could_not_ask),
                "{could_not_ask} only says the question could not be asked"
            );
        }
    }

    /// The device store keeps endpoints that are unplugged or disabled, and
    /// `GetDevice` answers for them, so the state — the same mask the walk
    /// enumerates with — is what makes a departed device a departure.
    #[test]
    fn an_endpoint_the_store_keeps_but_does_not_call_active_is_gone() {
        use windows::Win32::Media::Audio::{
            DEVICE_STATE_DISABLED, DEVICE_STATE_NOTPRESENT, DEVICE_STATE_UNPLUGGED,
        };

        assert!(endpoint_is_active(DEVICE_STATE_ACTIVE));
        for inactive in [
            DEVICE_STATE_DISABLED,
            DEVICE_STATE_NOTPRESENT,
            DEVICE_STATE_UNPLUGGED,
            DEVICE_STATE(0),
        ] {
            assert!(
                !endpoint_is_active(inactive),
                "{inactive:?} is not an endpoint the walk would have named"
            );
        }
    }

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
