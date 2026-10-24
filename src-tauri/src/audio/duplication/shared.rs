//! The state one engine's threads share, and the liveness rules read from it.
//!
//! [`EngineShared`] is the whole contract between an engine's capture thread and
//! its render threads: the format both sides speak, the two volume axes, the
//! flags of the synchronized start, and the single `shutdown` flag every wait on
//! every thread returns on. No COM interface lives here — one belongs to the one
//! thread that opened it ([`super::capture`] and [`super::render`] hold those) —
//! which is exactly why this type is what those threads may share.
//!
//! [`ExitReason`] says why a capture thread is leaving and [`ActiveRoute`] is what
//! the frontend reads about a live engine. The predicates below ([`source_quiet`],
//! [`mirror_quiet`], [`should_park`]) are the only place the parking rule is
//! decided, and [`retire_engine`] is the only way a caller takes an engine out of
//! service: setting the flag *and* waking, because a parked mirror or a held
//! capture thread otherwise sits out its backstop first.

use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::Thread;
use std::time::Instant;

use log::{info, warn};
use serde::Serialize;

use crate::audio::levels::SourceLevels;
use crate::audio::sessions;
use crate::audio::AudioError;

use super::format::SampleFormat;
use super::mirror::MirrorChannel;
use super::mix::target_frames;
use super::SOURCE_IDLE_MS;

/// Why an engine's capture thread exited.
pub(super) enum ExitReason {
    /// The shutdown flag was set (user stopped the route or re-routed).
    Stopped,
    /// The target process no longer exists.
    ProcessExited,
    /// A Windows API call failed.
    Error(AudioError),
    /// Every mirror is out of service and the pump has nothing left to feed.
    /// Internal to `capture_session`, which releases the loopback client,
    /// waits in `hold_after_lost_copies`, and replaces this with the reason
    /// the hold ended — an engine that only lost its copies must not announce
    /// itself as stopped, or the board takes the working primary route down.
    AllMirrorsLost,
}

impl ExitReason {
    pub(super) fn event_name(&self) -> &'static str {
        match self {
            ExitReason::Stopped => "stopped",
            ExitReason::ProcessExited => "process-exited",
            ExitReason::Error(_) => "error",
            // Never reaches the frontend: `capture_session` converts it.
            ExitReason::AllMirrorsLost => "all-mirrors-lost",
        }
    }

    pub(super) fn error_message(&self) -> Option<String> {
        match self {
            ExitReason::Error(e) => Some(e.to_string()),
            _ => None,
        }
    }
}

/// Immutable state shared by one engine's threads.
pub(super) struct EngineShared {
    pub(super) pid: u32,
    /// Executable this engine duplicates. The per-program level is keyed by it
    /// rather than by `pid`, because one program can hold several sessions.
    /// Must be the verbatim `AudioSession.exe_name` spelling — the `==`
    /// matches here and the exact map keys in `config.rs` depend on it.
    pub(super) exe_name: String,
    pub(super) generation: u64,
    /// Process creation time as a FILETIME (u64), used to detect PID reuse.
    pub(super) creation_time: u64,
    pub(super) shutdown: AtomicBool,
    pub(super) mirrors: Vec<Arc<MirrorChannel>>,
    /// The engine's capture thread, published only while it waits with no
    /// loopback consumer left (see `hold_after_lost_copies`), so a stop can
    /// end that wait without sitting out the poll interval. `None` at every
    /// other time: while the packet loop runs, that thread waits on a kernel
    /// event, which `Thread::unpark` cannot break anyway.
    pub(super) capture_worker: Mutex<Option<Thread>>,
    /// Device the OS plays natively, i.e. the one endpoint this engine cannot
    /// hold back in software. Only used to route delay updates to
    /// `primary_delay_ms` — the primary's *volume* is the program's session
    /// volume (see `session_volume_percent`), not a property of the device.
    pub(super) primary_device_id: String,
    /// The primary device's configured delay. It cannot be applied, but it is
    /// the reference the mirrors are measured against (see
    /// `group_min_delay_ms`), so a change has to reach live engines.
    pub(super) primary_delay_ms: AtomicI32,
    /// The routed program's session volume, in percent — what the Windows
    /// volume mixer shows for it, and the one lever that reaches the primary
    /// device's loudness, because the loopback tap sits *behind* the session
    /// volume. The mirrors divide their gain by the same factor (see
    /// `session_compensation`), so moving this moves the primary path alone.
    /// Floored at [`crate::config::PRIMARY_VOLUME_MIN_PERCENT`]: at 0 the
    /// capture is true silence and no gain can give the copies back.
    pub(super) session_volume_percent: AtomicU32,
    /// The session volume the program had before this engine claimed it, in
    /// percent. Giving it back is what keeps this control a property of the
    /// *route*: without it, stopping the route would leave the program quietly
    /// playing everywhere — and the volume mixer remembers the value for the
    /// next launch. Only set when a live session was actually read at start.
    pub(super) restore_volume_percent: AtomicU32,
    /// Whether `restore_volume_percent` is worth writing back: set only when
    /// the pre-route volume was read from a live session, so a program we
    /// never touched keeps whatever the user had set in the mixer.
    pub(super) restore_volume: AtomicBool,
    /// Serializes the session-volume claim (in `start`) against this engine's
    /// own restores (`stop`, teardown). The claim is two slow COM round trips
    /// with the promise set in between; a restore that ran in that window
    /// would decide nothing was claimed, and the claim's write would land
    /// after it — the program left at the route's loudness with no engine and
    /// no promise, the pre-route value gone for good. See the claim side.
    pub(super) volume_claim: Mutex<()>,
    /// The program's own level as a percentage of what it produced, applied to
    /// its audio before it reaches any device. Unlike a device's share of the
    /// group, this may exceed 100 — see `source_gain`. Live-adjustable.
    pub(super) source_volume_percent: AtomicU32,
    /// Shared table of what each program is measuring at. This engine publishes
    /// its own program's level there and reads the others' from it, which is the
    /// only way one program's level can be compared with another's.
    pub(super) levels: Arc<SourceLevels>,
    /// Raw bytes of the capture format (WAVEFORMATEX, possibly extensible).
    pub(super) format: Vec<u8>,
    /// How the capture format stores one sample, so volume can be applied to
    /// the bytes on their way to a mirror.
    pub(super) sample: SampleFormat,
    /// Bytes per frame of the capture format.
    pub(super) block_align: usize,
    /// Capture format's sample rate, for converting delay ms into frames.
    pub(super) sample_rate: u32,
    /// Frames every mirror keeps buffered (device buffer + ring) between the
    /// capture tap and playback, before any per-device delay compensation.
    pub(super) latency_frames: usize,
    /// Allowed drift past a mirror's target before frames get trimmed.
    pub(super) trim_slack_frames: usize,
    /// Whether per-device delay compensation is applied (see `delay_ms`).
    pub(super) sync_delays: AtomicBool,
    /// Set once every mirror is initialized and the pre-roll is filled (or the
    /// wait timed out); render clients Start together when this is set.
    pub(super) go: AtomicBool,
    /// Render threads that finished device initialization (success or failure).
    pub(super) ready_count: AtomicUsize,
    /// How many times the capture loop has woken up. Diagnostic, as the mirror
    /// counterpart is.
    pub(super) capture_wakeups: AtomicU64,
    /// When the engine was created. Origin for the wake summary below and for
    /// how long the source has been quiet.
    pub(super) started: Instant,
    /// Milliseconds since `started` at which the source last delivered a
    /// non-silent packet. Starts at zero, so an app that is already silent when
    /// its route is applied goes idle on the same schedule as one that falls
    /// silent later.
    pub(super) last_audio_ms: AtomicU64,
}

impl EngineShared {
    /// Whether every copy this engine was asked to make is out of service.
    ///
    /// A failed mirror ignores pushes, so once the last one goes the loopback
    /// client has nothing left to feed and the pump must not keep the endpoint
    /// busy for it (see `hold_after_lost_copies`). Mirrors are only ever
    /// disabled by `fail_mirror`, whose render thread has already returned by
    /// then, so an all-false reading means no consumer exists anywhere.
    pub(super) fn all_mirrors_lost(&self) -> bool {
        self.mirrors
            .iter()
            .all(|m| !m.enabled.load(Ordering::Relaxed))
    }

    /// Write the program's session volume back to what it was before this
    /// engine claimed it. Best effort and idempotent: a program whose session
    /// is gone has nothing left to restore, and one whose mixer value could
    /// not be read at start was never touched.
    pub(super) fn restore_session_volume(&self) {
        // Taking the promise rather than testing it is what keeps this off the
        // double-write list: the exit worker may have collected the same promise
        // a moment before its thread did. Under the claim lock, so a claim that
        // is mid-decision finishes before this restore reads the promise — the
        // claim then finds the shutdown flag on its own check and never writes.
        let _claim = self.volume_claim.lock().unwrap_or_else(|e| e.into_inner());
        let Some((pid, percent)) = self.take_restore_promise() else {
            return;
        };
        restore_session_volume_now(pid, percent);
    }

    /// Take this engine's promise to hand the program's loudness back, leaving
    /// nothing behind. `None` when it never claimed one, or when somebody has
    /// already taken it.
    pub(super) fn take_restore_promise(&self) -> Option<(u32, u32)> {
        if !self.restore_volume.swap(false, Ordering::Relaxed) {
            return None;
        }
        Some((
            self.pid,
            self.restore_volume_percent.load(Ordering::Relaxed),
        ))
    }
}

/// Write a program's session volume back and say so when it landed.
///
/// A free function because the exit path calls it from a thread that owns no
/// `DuplicationManager`: the process is leaving, and holding one to do this
/// would keep the audio service's slow round trips on the shutdown's critical
/// path.
pub fn restore_session_volume_now(pid: u32, percent: u32) {
    // `Ok(0)` is the benign half of this: the program has no live session, so
    // there is nothing left to give the loudness back to. A failed call is the
    // half that must not be quiet — the program keeps playing at the route's
    // value and the mixer remembers it for its next launch, with nothing on
    // screen or in the log to explain the difference.
    match sessions::set_session_volume(pid, percent as f32 / 100.0) {
        Ok(0) => {}
        Ok(_) => info!("restored session volume of PID {pid} to {percent}%"),
        Err(e) => warn!("giving PID {pid} its {percent}% back failed: {e}"),
    }
}

/// Wake the capture thread out of the copies-lost hold, if it is in one.
///
/// The same token semantics as [`MirrorChannel::wake`]: a thread that has not
/// parked yet keeps the token and its next park returns immediately, so a wake
/// arriving before the hold published the thread is not lost — the hold
/// re-checks `shutdown` at the top of every pass regardless.
pub(super) fn wake_capture(shared: &EngineShared) {
    if let Some(thread) = shared
        .capture_worker
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
    {
        thread.unpark();
    }
}

/// Take a removed engine out of service.
///
/// Setting `shutdown` and waking is the whole contract: mirrors may be parked
/// on a quiet source on their own threads rather than on the device, and the
/// capture thread may be waiting in `hold_after_lost_copies`; without the wake
/// either would sit out its backstop before the caller could join it. The
/// session-volume restore runs synchronously, before the caller moves on: the
/// next thing it may do is start a new engine for the same program, and that
/// engine reads the program's current session volume as its own pre-route
/// value — a restore racing that read would hand the new engine the wrong
/// baseline.
pub(super) fn retire_engine(shared: &Arc<EngineShared>) {
    shared.shutdown.store(true, Ordering::Relaxed);
    for mirror in &shared.mirrors {
        mirror.wake();
    }
    wake_capture(shared);
    shared.restore_session_volume();
}

/// Record that the source just produced audio. Called by the capture thread,
/// before it wakes the mirrors, so a mirror woken by the same packet never
/// observes the source as still quiet.
pub(super) fn note_audio(shared: &EngineShared) {
    shared.last_audio_ms.store(
        shared.started.elapsed().as_millis() as u64,
        Ordering::Relaxed,
    );
}

/// Whether the source has produced nothing for long enough that its mirrors may
/// stop playing.
pub(super) fn source_quiet(shared: &EngineShared) -> bool {
    should_park(
        shared.started.elapsed().as_millis() as u64,
        shared.last_audio_ms.load(Ordering::Relaxed),
    )
}

/// How deep this mirror's pipeline is, in milliseconds: how long audio keeps
/// playing after the source last produced any.
pub(super) fn mirror_pipeline_ms(shared: &EngineShared, mirror: &MirrorChannel) -> u64 {
    target_frames(shared, mirror) as u64 * 1_000 / shared.sample_rate.max(1) as u64
}

/// Whether this mirror may park: the source has been quiet for the idle window
/// *plus* this mirror's own pipeline depth. A mirror holding a large delay
/// compensation is still playing audio captured seconds ago, so parking on the
/// plain source threshold would cut up to a device buffer of that tail — the
/// park must only ever drop silence.
pub(super) fn mirror_quiet(shared: &EngineShared, mirror: &MirrorChannel) -> bool {
    should_park(
        shared.started.elapsed().as_millis() as u64,
        shared
            .last_audio_ms
            .load(Ordering::Relaxed)
            .saturating_add(mirror_pipeline_ms(shared, mirror)),
    )
}

/// Whether `now_ms - last_audio_ms` has reached the idle threshold. `last` is
/// zero before the first packet, which is what makes an engine that has never
/// heard anything go idle too.
pub(super) fn should_park(now_ms: u64, last_audio_ms: u64) -> bool {
    now_ms.saturating_sub(last_audio_ms) >= SOURCE_IDLE_MS
}

/// A live duplication engine and the device list it is currently serving.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveRoute {
    /// Process ID whose audio is being duplicated.
    pub pid: u32,
    /// Engine generation used to reject stale stopped events.
    pub generation: u64,
    /// Ordered route targets: primary first, then mirrors.
    pub device_ids: Vec<String>,
    /// The software-side latency each device of `device_ids` is playing at right
    /// now, in milliseconds and in the same order: this engine's pipeline depth
    /// for that device plus the endpoint's own reported stream latency. `None`
    /// for the primary, which Windows plays itself — there is no stream of ours
    /// to ask, and a made-up number would be worse than saying so. What a
    /// hardware codec or a Bluetooth link adds on top is invisible from here.
    pub latency_ms: Vec<Option<u32>>,
}
