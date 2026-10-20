//! Multi-device audio duplication ("route one app to several devices").
//!
//! Windows assigns exactly one default endpoint per app, so routing an app to
//! N > 1 devices is built from two channels:
//!
//! 1. Primary — device #1 becomes the app's persisted default endpoint via
//!    `AudioPolicyConfig` (see `routing.rs`); its audio flows there natively.
//! 2. Mirrors — every further device receives a software copy of the app's
//!    audio, produced here: a WASAPI *process loopback* capture taps the
//!    process's mixed output, and one event-driven render client per mirror
//!    device writes the same frames into that device.
//!
//! The tap uses `ActivateAudioInterfaceAsync` with
//! `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` (Windows 10 build 20348+).
//! Capture and mirror devices may run different mix formats: both sides
//! initialize with `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM` and
//! `AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY`, so WASAPI converts between the
//! shared capture format and each device's engine format. No virtual-audio
//! driver is involved, which keeps the project free of third-party executables.
//!
//! Lifecycle: [`DuplicationManager`] (Tauri state) owns one engine per PID.
//! Each engine is a capture thread plus one render thread per mirror. Threads
//! watch a shared `shutdown` flag and, when it is set — or when the target
//! process exits — they clean up, unregister the engine, and notify the
//! frontend via the `duplication-stopped` event. A single mirror that cannot be
//! opened or that errors out later does not take the engine down: it is dropped
//! from the route and reported on its own through `duplication-mirror-failed`,
//! so the remaining devices keep playing and the UI can say which one went quiet.
//! When *every* mirror fails, though, the loopback tap has no consumer left: the
//! engine releases its capture client and holds — registered, quiet, waiting for
//! a stop or the process's end — because a `duplication-stopped` would take the
//! still-playing primary route off the board with it. The state says as much:
//! `active_routes` reports such an engine on the primary device alone.
//!
//! Synchronization: render clients do not start independently. The capture
//! thread opens a gate once every device is initialized and every ring holds
//! one base pipeline of pre-roll (or after a timeout, e.g. a silent app), so
//! all mirrors Start together instead of whenever their device happens to be
//! ready — a cold Bluetooth connection can take seconds, and without the gate
//! the wired device runs ahead by that whole setup time. After the start, every
//! mirror keeps its own backlog between the capture tap and playback: the same
//! base latency for all of them, plus how far its own delay sits above the
//! earliest device of the group, so they play the same sample at the same
//! moment offset by exactly the differences that were configured. A delay is
//! realized as silence placed ahead of the mirror's audio, and clock drift
//! between devices is absorbed by trimming the lagging device's oldest frames
//! and topping the fast device up with silence (a few milliseconds every few
//! minutes at typical crystal tolerance). The same top-up realizes a delay
//! changed while the engine is running. Hardware latency, e.g. a Bluetooth
//! codec's buffer, adds on top and is outside software control.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::Thread;
use std::time::{Duration, Instant};

use log::{info, warn};
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use windows::core::{implement, IUnknown, Interface, HRESULT, PCWSTR, PROPVARIANT};
use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, STILL_ACTIVE, WAIT_TIMEOUT};
use windows::Win32::Media::Audio::{
    eConsole, eRender, ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
    IAudioCaptureClient, IAudioClient, IAudioRenderClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK,
    AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, AUDIOCLIENT_ACTIVATION_PARAMS,
    AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
    VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX,
};
use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemAlloc, CoTaskMemFree, CLSCTX_ALL};
use windows::Win32::System::Threading::{
    CreateEventW, GetExitCodeProcess, GetProcessTimes, OpenProcess, WaitForSingleObject,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::audio::levels::SourceLevels;
use crate::audio::AudioError;
use crate::config::{
    DelayConfig, PrimaryVolumeConfig, SourceVolumeConfig, VolumeConfig, DELAY_MAX_MS,
};

/// Shared-mode stream buffer, in hundreds of nanoseconds (200 ms).
const STREAM_BUFFER_DURATION: i64 = 2_000_000;
/// Render threads poll the shutdown flag at this interval when idle.
const RENDER_WAIT_MS: u32 = 250;
/// Capture thread polls process liveness at this interval when silent.
const CAPTURE_WAIT_MS: u32 = 2_000;
/// Upper bound for the asynchronous process-loopback activation.
const ACTIVATION_TIMEOUT: Duration = Duration::from_secs(5);
/// Pipeline latency every mirror keeps between the capture tap and playback,
/// so all mirrors play the same sample at (approximately) the same moment.
const LATENCY_TARGET_MS: usize = 100;
/// How far a mirror's pipeline may drift past the target before its render
/// thread trims the oldest frames by the excess. Clock crystals differ by tens
/// of ppm, so this fires rarely and each trim is a few milliseconds of audio.
const TRIM_SLACK_MS: usize = 20;
/// Upper bound for waiting on the synchronized start. A silent app never fills
/// the pre-roll, and starting un-synced while silence plays is harmless.
const PRE_ROLL_TIMEOUT: Duration = Duration::from_secs(4);
/// Backstop interval for a render thread waiting for the start gate. The gate
/// wakes the mirrors when it opens; this only bounds a wakeup that never
/// arrives.
const GATE_POLL: Duration = Duration::from_millis(250);
/// How long a source must have produced nothing before its mirrors stop
/// playing and let the device idle. Well clear of the pipeline's own jitter (a
/// few periods, against a `TRIM_SLACK_MS` of slack) so a pause between two
/// packets never reads as silence.
const SOURCE_IDLE_MS: u64 = 1_500;
/// Backstop interval for a mirror parked on a quiet source. A packet wakes the
/// mirror directly (see `MirrorChannel::wake`); this only bounds how long a
/// wakeup that never arrives can hold audio back, so it is short enough that a
/// missed one is heard as a stutter rather than as a gap.
const PARK_POLL: Duration = Duration::from_millis(250);

/// Generations handed out to engines so a stale thread can never unregister a
/// newer engine that replaced it for the same PID.
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

/// Why an engine's capture thread exited.
enum ExitReason {
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
    fn event_name(&self) -> &'static str {
        match self {
            ExitReason::Stopped => "stopped",
            ExitReason::ProcessExited => "process-exited",
            ExitReason::Error(_) => "error",
            // Never reaches the frontend: `capture_session` converts it.
            ExitReason::AllMirrorsLost => "all-mirrors-lost",
        }
    }

    fn error_message(&self) -> Option<String> {
        match self {
            ExitReason::Error(e) => Some(e.to_string()),
            _ => None,
        }
    }
}

/// How one sample is stored in the shared capture format.
///
/// Windows mix formats are float32 in practice, but a device may hand back
/// extensible PCM, so the integer widths are handled as well. A format this
/// engine does not understand leaves the audio untouched rather than mangled.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SampleFormat {
    Float32,
    Float64,
    /// Signed little-endian integers, 2, 3 or 4 bytes wide.
    Int(usize),
    /// Not scaled; per-device volume is skipped for the stream.
    Unknown,
}

impl SampleFormat {
    /// Read the format out of a `WAVEFORMATEX`, which may be extensible.
    fn parse(format: &[u8]) -> Self {
        const WAVE_FORMAT_PCM: u16 = 0x0001;
        const WAVE_FORMAT_IEEE_FLOAT: u16 = 0x0003;
        const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;
        /// `KSDATAFORMAT_SUBTYPE_IEEE_FLOAT`, first four bytes as laid out in
        /// memory (the GUID's first field is little-endian).
        const FLOAT_SUBTYPE: [u8; 4] = [0x03, 0x00, 0x00, 0x00];
        /// Offset of `SubFormat` inside a `WAVEFORMATEXTENSIBLE`.
        const SUBFORMAT_OFFSET: usize = 24;
        /// `WAVEFORMATEX` (18 bytes) plus the 22 bytes extensible appends.
        const EXTENSIBLE_LEN: usize = 40;

        if format.len() < core::mem::size_of::<WAVEFORMATEX>() {
            return Self::Unknown;
        }
        // SAFETY: the length was checked above; WAVEFORMATEX is packed, so
        // reading it from an unaligned byte slice is sound.
        let wfx = unsafe { &*(format.as_ptr() as *const WAVEFORMATEX) };
        let tag = if wfx.wFormatTag == WAVE_FORMAT_EXTENSIBLE && format.len() >= EXTENSIBLE_LEN {
            let sub = &format[SUBFORMAT_OFFSET..SUBFORMAT_OFFSET + 4];
            if sub == FLOAT_SUBTYPE {
                WAVE_FORMAT_IEEE_FLOAT
            } else {
                WAVE_FORMAT_PCM
            }
        } else {
            wfx.wFormatTag
        };
        match (tag, wfx.wBitsPerSample as usize) {
            (WAVE_FORMAT_IEEE_FLOAT, 32) => Self::Float32,
            (WAVE_FORMAT_IEEE_FLOAT, 64) => Self::Float64,
            (WAVE_FORMAT_PCM, bits @ (16 | 24 | 32)) => Self::Int(bits / 8),
            _ => Self::Unknown,
        }
    }
}

/// Read a little-endian signed integer of 2–4 bytes, sign-extended to `i32`.
fn read_int_le(bytes: &[u8]) -> i32 {
    let mut raw = 0u32;
    for (i, byte) in bytes.iter().enumerate() {
        raw |= (*byte as u32) << (8 * i);
    }
    let shift = 32 - 8 * bytes.len() as u32;
    ((raw << shift) as i32) >> shift
}

/// Write `value` as a little-endian signed integer of `bytes.len()` bytes.
fn write_int_le(bytes: &mut [u8], value: i32) {
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = ((value >> (8 * i)) & 0xFF) as u8;
    }
}

/// Smoothing window for a program's level estimate.
///
/// Short enough to describe what is playing now rather than everything since
/// the engine started, long enough that the estimate does not swing packet to
/// packet.
const LEVEL_WINDOW_MS: f32 = 300.0;
/// Release time of the peak estimate: how long the loudest sample seen keeps
/// its influence.
///
/// A gain is bounded by this peak, so it has to outlive the short peaks of
/// ordinary program material without pinning the estimate to one loud moment
/// for the rest of the session. Long enough to survive a transient, short
/// enough that a program which has genuinely quietened down stops being held
/// back by a moment from a minute ago.
const PEAK_RELEASE_MS: f32 = 2_000.0;
/// How often the running estimate is published. The level cannot change
/// meaningfully faster than this, and publishing per packet would take the
/// shared table's lock a hundred times a second per engine.
const LEVEL_PUBLISH_MS: u64 = 100;

/// The running level estimate of one program's audio.
///
/// Owned by that engine's capture thread, which is its only writer, and folded
/// from the packets as they arrive. Two numbers, because an alignment needs
/// both: a stable level to bring everything to, and a worst case that the gain
/// it computes has to stay under.
#[derive(Default)]
struct LevelTracker {
    /// Mean square of the samples, smoothed over `LEVEL_WINDOW_MS`.
    rms_sq: f32,
    /// Loudest sample seen, fading over `PEAK_RELEASE_MS`.
    peak: f32,
    /// Milliseconds folded so far, which is what sets the smoothing weight.
    elapsed_ms: f32,
    /// When the estimate was last published, so the shared table is written on
    /// a schedule rather than per packet.
    published_at: Option<Instant>,
}

impl LevelTracker {
    /// Fold one chunk in. `mean_sq` and `peak` are fractions of full scale.
    fn fold(&mut self, mean_sq: f32, peak: f32, chunk_ms: f32) {
        // The first chunk seeds the average instead of fading up from silence,
        // which would understate a program that has only just started playing.
        let alpha = if self.elapsed_ms == 0.0 {
            1.0
        } else {
            (chunk_ms / LEVEL_WINDOW_MS).clamp(0.0, 1.0)
        };
        self.rms_sq += (mean_sq - self.rms_sq) * alpha;
        let decay = (1.0 - chunk_ms / PEAK_RELEASE_MS).clamp(0.0, 1.0);
        self.peak = (self.peak * decay).max(peak);
        self.elapsed_ms += chunk_ms;
    }

    /// The smoothed level, as a fraction of full scale.
    fn rms(&self) -> f32 {
        self.rms_sq.max(0.0).sqrt()
    }

    /// Publish the estimate if `LEVEL_PUBLISH_MS` has passed since the last one.
    fn publish_if_due(&mut self, levels: &SourceLevels, exe_name: &str, pid: u32) {
        let due = self
            .published_at
            .is_none_or(|at| at.elapsed() >= Duration::from_millis(LEVEL_PUBLISH_MS));
        if !due {
            return;
        }
        self.published_at = Some(Instant::now());
        levels.record(exe_name, pid, self.rms(), self.peak);
    }
}

/// Peak and mean square of one chunk of interleaved samples, both as fractions
/// of full scale, or `None` for a format whose samples cannot be read.
///
/// A format this does not understand is left out of the estimate rather than
/// counted as silence: reporting a program as quiet when it is merely
/// unreadable would have an alignment amplify it.
fn measure_chunk(bytes: &[u8], format: SampleFormat) -> Option<(f32, f32)> {
    // (sample count, sum of squares, loudest magnitude), all in units of full
    // scale so the three kinds of sample are folded the same way afterwards.
    let (count, sum_sq, peak) = match format {
        SampleFormat::Float32 => {
            let mut sum_sq = 0.0f64;
            let mut peak = 0.0f32;
            for sample in bytes.as_chunks::<4>().0 {
                let value = f32::from_le_bytes(*sample);
                sum_sq += (value as f64) * (value as f64);
                peak = peak.max(value.abs());
            }
            (bytes.len() / 4, sum_sq, peak)
        }
        SampleFormat::Float64 => {
            let mut sum_sq = 0.0f64;
            let mut peak = 0.0f32;
            for sample in bytes.as_chunks::<8>().0 {
                let value = f64::from_le_bytes(*sample);
                sum_sq += value * value;
                peak = peak.max(value.abs() as f32);
            }
            (bytes.len() / 8, sum_sq, peak)
        }
        SampleFormat::Int(width @ 2..=4) => {
            let full_scale = match width {
                2 => i16::MAX as f64,
                3 => 8_388_607.0,
                _ => i32::MAX as f64,
            };
            let mut sum_sq = 0.0f64;
            let mut peak = 0.0f32;
            let mut count = 0usize;
            for sample in bytes.chunks_exact(width) {
                let value = read_int_le(sample) as f64 / full_scale;
                sum_sq += value * value;
                peak = peak.max(value.abs() as f32);
                count += 1;
            }
            (count, sum_sq, peak)
        }
        _ => return None,
    };
    if count == 0 {
        return None;
    }
    Some(((sum_sq / count as f64) as f32, peak))
}

/// Fold one captured chunk into the engine's level estimate, in the units the
/// program produced.
///
/// The tap sits behind the session volume (see `session_compensation`), so what
/// arrives here is the program's audio at the level the *primary* plays it — and
/// the mirrors divide that same factor straight back out again. Publishing the
/// estimate as the program produced it is what keeps the level alignment honest:
/// read behind the session volume, two programmes with different primary volumes
/// measure an exact session-ratio apart and the gains "aligning" them would be
/// wrong by that same ratio on every device they are copied to. The factor
/// scales the mean square by its square and the peak by itself.
fn measure_into(level: &mut LevelTracker, shared: &EngineShared, chunk: &[u8], frames: u32) {
    let Some((mean_sq, peak)) = measure_chunk(chunk, shared.sample) else {
        return;
    };
    let produced = f64::from(session_compensation(shared));
    let chunk_ms = frames as f32 * 1000.0 / shared.sample_rate.max(1) as f32;
    level.fold(
        (f64::from(mean_sq) * produced * produced) as f32,
        (f64::from(peak) * produced) as f32,
        chunk_ms,
    );
    level.publish_if_due(&shared.levels, &shared.exe_name, shared.pid);
}

/// Scale every sample of `bytes` by `gain`, in place.
///
/// This runs on the capture-format bytes on their way into one mirror, and that
/// format is exactly what the mirror's render client was initialized with, so
/// the device receives the shape it expects. Only whole samples are scaled — a
/// trailing partial sample, which an endpoint never produces, is left as it is.
///
/// Only *exact* unity is skipped. The shortcut was always about not walking the
/// buffer when there is nothing to do, but testing `>= 1.0` also discarded
/// amplification silently, which a per-program level needs. Integer formats
/// saturate at full scale because they cannot represent more; a float format is
/// allowed to carry values past full scale rather than being clipped here,
/// because the level that produced such a gain was bounded by that program's
/// own measured peak (see the level alignment), and a hand-set value is the
/// user's own call.
fn apply_gain(bytes: &mut [u8], format: SampleFormat, gain: f32) {
    if gain == 1.0 {
        return;
    }
    match format {
        SampleFormat::Float32 => {
            for sample in bytes.as_chunks_mut::<4>().0 {
                let value = f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]]) * gain;
                sample.copy_from_slice(&value.to_le_bytes());
            }
        }
        SampleFormat::Float64 => {
            for sample in bytes.as_chunks_mut::<8>().0 {
                let mut raw = [0u8; 8];
                raw.copy_from_slice(sample);
                let value = f64::from_le_bytes(raw) * gain as f64;
                sample.copy_from_slice(&value.to_le_bytes());
            }
        }
        SampleFormat::Int(width @ 2..=4) => {
            let max = match width {
                2 => i16::MAX as f32,
                3 => 8_388_607.0,
                _ => i32::MAX as f32,
            };
            for sample in bytes.chunks_exact_mut(width) {
                let scaled = (read_int_le(sample) as f32 * gain)
                    .round()
                    .clamp(-max - 1.0, max);
                write_int_le(sample, scaled as i32);
            }
        }
        _ => {}
    }
}

/// One mirror device with its frame ring buffer.
struct MirrorChannel {
    device_id: String,
    /// Raw capture-format bytes, always a whole number of frames.
    ring: Mutex<VecDeque<u8>>,
    /// Ring capacity in bytes (base latency + max delay + margin).
    capacity: usize,
    /// Extra software delay for this mirror in milliseconds, measured against
    /// the app's audio as captured — the same unit for every device, with no
    /// device singled out as the reference. Only the difference to the earliest
    /// device of the group is realizable (see `group_min_delay_ms`), so a value
    /// below that reference just keeps the mirror at the base latency.
    /// Live-adjustable.
    delay_ms: AtomicI32,
    /// This device's share (0–100) of the group's loudest device. The render
    /// side scales its frames by `own / max`, so 100 leaves the audio as the
    /// app produced it; only attenuation is realizable, which is why the
    /// loudest device of the group is the reference. Live-adjustable.
    volume_percent: AtomicU32,
    /// Cleared when the device fails to open or errors out; pushes and pops
    /// become no-ops so the remaining mirrors keep playing.
    enabled: AtomicBool,
    /// How many times this mirror's render loop has woken up. Diagnostic: it is
    /// what lets an idle engine's cost in scheduler wakeups be attributed to a
    /// route at all (see `capture_main`).
    wakeups: AtomicU64,
    /// The endpoint's own stream latency in milliseconds, asked of the render
    /// client once it is initialized. Zero until then, and zero if the query
    /// fails, which the reporting side reads as "not measured" rather than as
    /// "no latency" — a started stream is never free. This is the part of the
    /// total that belongs to the device rather than to this engine, and it is
    /// where a hardware codec or a Bluetooth link adds on top without saying so.
    stream_latency_ms: AtomicU32,
    /// The render thread that owns this mirror, published for as long as it
    /// runs so the capture side can wake it out of an idle park. `None` until
    /// that thread reaches its render loop, and a wake for a thread that is not
    /// parked is what `Thread::unpark` already handles: it leaves a token that
    /// the next park consumes instead of blocking.
    worker: Mutex<Option<Thread>>,
}

impl MirrorChannel {
    /// Current buffered amount in bytes.
    fn buffered_bytes(&self) -> usize {
        self.ring.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// Drop the oldest `frames` frames. The ring always holds whole frames,
    /// so the remainder stays frame-aligned.
    fn drop_oldest(&self, frames: usize, block_align: usize) {
        let mut ring = self.ring.lock().unwrap_or_else(|e| e.into_inner());
        let drop = (frames * block_align).min(ring.len());
        ring.drain(..drop);
    }

    /// Insert `frames` frames of silence at the front of the ring, clamped to
    /// the ring's free capacity. This raises the mirror's pipeline to its
    /// latency target — e.g. right after its delay compensation was increased
    /// or latency sync was enabled — so the larger target takes effect
    /// immediately instead of being silently unreachable (a full device buffer
    /// plus real-time capture inflow never fills the gap on its own).
    fn prepend_silence(&self, frames: usize, block_align: usize) {
        if frames == 0 || !self.enabled.load(Ordering::Relaxed) {
            return;
        }
        let mut ring = self.ring.lock().unwrap_or_else(|e| e.into_inner());
        let headroom = self.capacity.saturating_sub(ring.len());
        let bytes = (frames * block_align).min(headroom - headroom % block_align);
        if bytes == 0 {
            return;
        }
        // Resize with zeros appended, then rotate them to the front: one
        // allocation instead of a per-byte push_front.
        let old_len = ring.len();
        ring.resize(old_len + bytes, 0);
        ring.rotate_right(bytes);
    }

    /// Enqueue one capture chunk, capping the ring (whole frames only) so a
    /// slow-to-open device cannot accumulate unbounded stale audio before the
    /// synchronized start; the render side trims toward the latency target.
    fn push(&self, chunk: &[u8], block_align: usize) {
        if !self.enabled.load(Ordering::Relaxed) {
            return;
        }
        let mut ring = self.ring.lock().unwrap_or_else(|e| e.into_inner());
        ring.extend(chunk);
        let excess = ring.len().saturating_sub(self.capacity);
        if excess > 0 {
            let aligned = excess - excess % block_align;
            ring.drain(..aligned);
        }
    }

    /// Wake the render thread owning this mirror if it is parked waiting for
    /// its source to come back. Cheap and safe to call unconditionally, which
    /// is what the capture side does with every packet it pushes.
    fn wake(&self) {
        if let Some(thread) = self
            .worker
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            thread.unpark();
        }
    }

    /// Take at most `max_frames` frames of audio for one render cycle into
    /// `out`, the render thread's own scratch buffer — the cycle runs about a
    /// hundred times a second, and a fresh allocation each time is one the
    /// audio thread does not need to make.
    fn pop(&self, max_frames: usize, block_align: usize, out: &mut Vec<u8>) {
        out.clear();
        if max_frames == 0 || !self.enabled.load(Ordering::Relaxed) {
            return;
        }
        let mut ring = self.ring.lock().unwrap_or_else(|e| e.into_inner());
        let take = ring.len().min(max_frames * block_align);
        let aligned = take - take % block_align;
        out.extend(ring.drain(..aligned));
    }
}

/// Immutable state shared by one engine's threads.
struct EngineShared {
    pid: u32,
    /// Executable this engine duplicates. The per-program level is keyed by it
    /// rather than by `pid`, because one program can hold several sessions.
    /// Must be the verbatim `AudioSession.exe_name` spelling — the `==`
    /// matches here and the exact map keys in `config.rs` depend on it.
    exe_name: String,
    generation: u64,
    /// Process creation time as a FILETIME (u64), used to detect PID reuse.
    creation_time: u64,
    shutdown: AtomicBool,
    mirrors: Vec<Arc<MirrorChannel>>,
    /// The engine's capture thread, published only while it waits with no
    /// loopback consumer left (see `hold_after_lost_copies`), so a stop can
    /// end that wait without sitting out the poll interval. `None` at every
    /// other time: while the packet loop runs, that thread waits on a kernel
    /// event, which `Thread::unpark` cannot break anyway.
    capture_worker: Mutex<Option<Thread>>,
    /// Device the OS plays natively, i.e. the one endpoint this engine cannot
    /// hold back in software. Only used to route delay updates to
    /// `primary_delay_ms` — the primary's *volume* is the program's session
    /// volume (see `session_volume_percent`), not a property of the device.
    primary_device_id: String,
    /// The primary device's configured delay. It cannot be applied, but it is
    /// the reference the mirrors are measured against (see
    /// `group_min_delay_ms`), so a change has to reach live engines.
    primary_delay_ms: AtomicI32,
    /// The routed program's session volume, in percent — what the Windows
    /// volume mixer shows for it, and the one lever that reaches the primary
    /// device's loudness, because the loopback tap sits *behind* the session
    /// volume. The mirrors divide their gain by the same factor (see
    /// `session_compensation`), so moving this moves the primary path alone.
    /// Floored at [`crate::config::PRIMARY_VOLUME_MIN_PERCENT`]: at 0 the
    /// capture is true silence and no gain can give the copies back.
    session_volume_percent: AtomicU32,
    /// The session volume the program had before this engine claimed it, in
    /// percent. Giving it back is what keeps this control a property of the
    /// *route*: without it, stopping the route would leave the program quietly
    /// playing everywhere — and the volume mixer remembers the value for the
    /// next launch. Only set when a live session was actually read at start.
    restore_volume_percent: AtomicU32,
    /// Whether `restore_volume_percent` is worth writing back: set only when
    /// the pre-route volume was read from a live session, so a program we
    /// never touched keeps whatever the user had set in the mixer.
    restore_volume: AtomicBool,
    /// Serializes the session-volume claim (in `start`) against this engine's
    /// own restores (`stop`, teardown). The claim is two slow COM round trips
    /// with the promise set in between; a restore that ran in that window
    /// would decide nothing was claimed, and the claim's write would land
    /// after it — the program left at the route's loudness with no engine and
    /// no promise, the pre-route value gone for good. See the claim side.
    volume_claim: Mutex<()>,
    /// The program's own level as a percentage of what it produced, applied to
    /// its audio before it reaches any device. Unlike a device's share of the
    /// group, this may exceed 100 — see `source_gain`. Live-adjustable.
    source_volume_percent: AtomicU32,
    /// Shared table of what each program is measuring at. This engine publishes
    /// its own program's level there and reads the others' from it, which is the
    /// only way one program's level can be compared with another's.
    levels: Arc<SourceLevels>,
    /// Raw bytes of the capture format (WAVEFORMATEX, possibly extensible).
    format: Vec<u8>,
    /// How the capture format stores one sample, so volume can be applied to
    /// the bytes on their way to a mirror.
    sample: SampleFormat,
    /// Bytes per frame of the capture format.
    block_align: usize,
    /// Capture format's sample rate, for converting delay ms into frames.
    sample_rate: u32,
    /// Frames every mirror keeps buffered (device buffer + ring) between the
    /// capture tap and playback, before any per-device delay compensation.
    latency_frames: usize,
    /// Allowed drift past a mirror's target before frames get trimmed.
    trim_slack_frames: usize,
    /// Whether per-device delay compensation is applied (see `delay_ms`).
    sync_delays: AtomicBool,
    /// Set once every mirror is initialized and the pre-roll is filled (or the
    /// wait timed out); render clients Start together when this is set.
    go: AtomicBool,
    /// Render threads that finished device initialization (success or failure).
    ready_count: AtomicUsize,
    /// How many times the capture loop has woken up. Diagnostic, as the mirror
    /// counterpart is.
    capture_wakeups: AtomicU64,
    /// When the engine was created. Origin for the wake summary below and for
    /// how long the source has been quiet.
    started: Instant,
    /// Milliseconds since `started` at which the source last delivered a
    /// non-silent packet. Starts at zero, so an app that is already silent when
    /// its route is applied goes idle on the same schedule as one that falls
    /// silent later.
    last_audio_ms: AtomicU64,
}

impl EngineShared {
    /// Whether every copy this engine was asked to make is out of service.
    ///
    /// A failed mirror ignores pushes, so once the last one goes the loopback
    /// client has nothing left to feed and the pump must not keep the endpoint
    /// busy for it (see `hold_after_lost_copies`). Mirrors are only ever
    /// disabled by `fail_mirror`, whose render thread has already returned by
    /// then, so an all-false reading means no consumer exists anywhere.
    fn all_mirrors_lost(&self) -> bool {
        self.mirrors
            .iter()
            .all(|m| !m.enabled.load(Ordering::Relaxed))
    }

    /// Write the program's session volume back to what it was before this
    /// engine claimed it. Best effort and idempotent: a program whose session
    /// is gone has nothing left to restore, and one whose mixer value could
    /// not be read at start was never touched.
    fn restore_session_volume(&self) {
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
    fn take_restore_promise(&self) -> Option<(u32, u32)> {
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
    match super::sessions::set_session_volume(pid, percent as f32 / 100.0) {
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
fn wake_capture(shared: &EngineShared) {
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
fn retire_engine(shared: &Arc<EngineShared>) {
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
fn note_audio(shared: &EngineShared) {
    shared.last_audio_ms.store(
        shared.started.elapsed().as_millis() as u64,
        Ordering::Relaxed,
    );
}

/// Whether the source has produced nothing for long enough that its mirrors may
/// stop playing.
fn source_quiet(shared: &EngineShared) -> bool {
    should_park(
        shared.started.elapsed().as_millis() as u64,
        shared.last_audio_ms.load(Ordering::Relaxed),
    )
}

/// How deep this mirror's pipeline is, in milliseconds: how long audio keeps
/// playing after the source last produced any.
fn mirror_pipeline_ms(shared: &EngineShared, mirror: &MirrorChannel) -> u64 {
    target_frames(shared, mirror) as u64 * 1_000 / shared.sample_rate.max(1) as u64
}

/// Whether this mirror may park: the source has been quiet for the idle window
/// *plus* this mirror's own pipeline depth. A mirror holding a large delay
/// compensation is still playing audio captured seconds ago, so parking on the
/// plain source threshold would cut up to a device buffer of that tail — the
/// park must only ever drop silence.
fn mirror_quiet(shared: &EngineShared, mirror: &MirrorChannel) -> bool {
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
fn should_park(now_ms: u64, last_audio_ms: u64) -> bool {
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

/// In-flight-start bookkeeping, so a stop can never miss a landing start.
///
/// `start` registers itself here, under the same `engines` lock as its
/// eviction, *before* the slow COM work (mix format, session-volume claim);
/// `stop` waits for the count to drain before removing. Without this, a
/// `stop_route` landing between a start's eviction and its insertion removes
/// nothing, and the insertion then RESURRECTS an engine with no route — the
/// mirrors keep playing while the board shows nothing.
#[derive(Default)]
struct StartRegistry {
    /// pid → starts in flight for it: evicted the incumbent, not yet landed
    /// (or withdrew) their engine. More than one because two `apply_route`s
    /// for the same pid can overlap; the pid stays claimed until both settle.
    counts: Mutex<HashMap<u32, u32>>,
    /// Notified on every decrement, so a waiting `stop` cannot sleep past
    /// the start it waits for.
    landed: Condvar,
}

impl StartRegistry {
    /// Count one more in-flight start for `pid`. Called while the caller holds
    /// the `engines` lock — that pairing is what makes the eviction and the
    /// registration one step no `stop` can slip between.
    fn begin(&self, pid: u32) {
        let mut counts = self.counts.lock().unwrap_or_else(|e| e.into_inner());
        let count = counts.entry(pid).or_insert(0);
        *count = count.saturating_add(1);
    }

    /// One fewer. The notify is unconditional: a waiter for another pid
    /// re-checks its own entry and sleeps again, and losing this one's wake
    /// would strand a `stop` past a start that already landed.
    fn clear(&self, pid: u32) {
        let mut counts = self.counts.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(count) = counts.get_mut(&pid) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                counts.remove(&pid);
            }
        }
        self.landed.notify_all();
    }

    /// Sleep until `pid` has no start in flight. The caller's removal then
    /// sees whatever that start landed — or nothing, if it withdrew, in which
    /// case it retires nothing too. A stop arriving before any start registered
    /// does not wait: honoring it over a *later* apply is the frontend's
    /// ordering, and a route the user asked for after the stop has finished is
    /// simply the next word, not a resurrection.
    fn wait_for_quiet(&self, pid: u32) {
        let mut counts = self.counts.lock().unwrap_or_else(|e| e.into_inner());
        while counts.contains_key(&pid) {
            counts = self.landed.wait(counts).unwrap_or_else(|e| e.into_inner());
        }
    }
}

/// Clears one in-flight start on the way out of `DuplicationManager::start`,
/// on every return path — including the `?` and early `Err`/`Ok` returns that
/// happen before an engine lands. A start that never lands must not leave a
/// `stop` waiting on a count nobody will clear.
struct StartGuard<'a> {
    registry: &'a StartRegistry,
    pid: u32,
}

impl Drop for StartGuard<'_> {
    fn drop(&mut self) {
        self.registry.clear(self.pid);
    }
}

/// Per-process duplication engines, managed as Tauri state.
pub struct DuplicationManager {
    engines: Mutex<HashMap<u32, Arc<EngineShared>>>,
    /// Starts that are between their eviction and their insertion (see
    /// `StartRegistry`); `stop` waits this out, `begin_start` fills it.
    starting: StartRegistry,
    /// Persisted per-device delay compensation values.
    delays: Arc<DelayConfig>,
    /// Persisted per-device volume values.
    volumes: Arc<VolumeConfig>,
    /// Persisted per-program level values.
    sources: Arc<SourceVolumeConfig>,
    /// Persisted per-program primary (session) volume values.
    primary_volumes: Arc<PrimaryVolumeConfig>,
    /// Shared per-program level measurements.
    levels: Arc<SourceLevels>,
    /// Whether delay compensation is enabled. Always on: the compensation is
    /// the whole point of the feature, so it has no switch of its own.
    delay_sync: AtomicBool,
}

impl DuplicationManager {
    /// Create the manager, reading initial per-device values from `delays` and
    /// `volumes`.
    pub fn new(
        delays: Arc<DelayConfig>,
        volumes: Arc<VolumeConfig>,
        sources: Arc<SourceVolumeConfig>,
        primary_volumes: Arc<PrimaryVolumeConfig>,
        levels: Arc<SourceLevels>,
    ) -> Self {
        Self {
            engines: Mutex::new(HashMap::new()),
            starting: StartRegistry::default(),
            delays,
            volumes,
            sources,
            primary_volumes,
            levels,
            delay_sync: AtomicBool::new(true),
        }
    }

    /// Push a new delay value to any live engine using `device_id`, regardless
    /// of whether the device is a mirror or the primary one. Persisting the
    /// value is the caller's job (see `DelayConfig`).
    pub fn update_delay(&self, device_id: &str, delay_ms: i32) {
        for engine in self
            .engines
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            if engine.primary_device_id == device_id {
                engine.primary_delay_ms.store(delay_ms, Ordering::Relaxed);
            }
            for mirror in &engine.mirrors {
                if mirror.device_id == device_id {
                    mirror.delay_ms.store(delay_ms, Ordering::Relaxed);
                }
            }
        }
    }

    /// Push a new volume value to any live engine using `device_id` as a
    /// mirror. Persisting the value is the caller's job (see `VolumeConfig`).
    ///
    /// The primary device takes no share anymore: its loudness is the
    /// program's session volume (`update_primary_volume`), which is a
    /// property of the program rather than of the device. A value stored for
    /// a device applies whenever that device plays as a copy — including for
    /// an engine where it is the primary of one route and a mirror of
    /// another.
    pub fn update_volume(&self, device_id: &str, percent: u32) {
        for engine in self
            .engines
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            for mirror in &engine.mirrors {
                if mirror.device_id == device_id {
                    mirror.volume_percent.store(percent, Ordering::Relaxed);
                }
            }
        }
    }

    /// Push a program's primary volume — its session volume — to every engine
    /// running for it, and write it onto the live sessions so it takes effect
    /// now. Matched by executable name, the same ownership rule the level
    /// uses; persisting the value is the caller's job (see
    /// `PrimaryVolumeConfig`).
    ///
    /// A program with no live session is left as it is: the value is stored,
    /// and the next engine this program gets applies it at start.
    ///
    /// Each engine's write is serialized against that engine's own claim/restore
    /// (see `volume_claim`), for the same reason the claim is: a `stop` landing
    /// mid-write hands the pre-route loudness back, and unless the two are kept
    /// apart the restore can land *first* — leaving the program at the route's
    /// value with no engine left to undo it, and the mixer remembering that
    /// value for the program's next launch.
    pub fn update_primary_volume(&self, exe_name: &str, percent: u32) {
        // The engines are collected under the lock and written to outside of
        // it: `set_session_volume` is a full device and session enumeration,
        // and no start, stop or route read should queue behind one per engine.
        let targets: Vec<Arc<EngineShared>> = self
            .engines
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|engine| engine.exe_name == exe_name)
            .cloned()
            .collect();
        for engine in targets {
            engine
                .session_volume_percent
                .store(percent, Ordering::Relaxed);
            let _claim = engine
                .volume_claim
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            // The engine is on its way down and its restore owns the promise:
            // writing here would stand after the value it hands back. The
            // stored percentage is what the next engine for this program
            // applies, so the user's number is not lost by skipping the write.
            if engine.shutdown.load(Ordering::Relaxed) {
                continue;
            }
            match super::sessions::set_session_volume(engine.pid, percent as f32 / 100.0) {
                Ok(0) => log::warn!(
                    "no live session for PID {} — primary volume stored for its next route",
                    engine.pid
                ),
                Ok(_) => {}
                Err(e) => log::warn!("writing primary volume onto PID {} failed: {e}", engine.pid),
            }
        }
    }

    /// Give every engine's program its pre-route session volume back.
    ///
    /// Called on app exit: the route ends with the process, and a session
    /// volume left behind would keep the program quietly playing everywhere —
    /// the volume mixer remembers the value for its next launch.
    ///
    /// Returns the loudness every running engine still owes, as `(pid, percent)`,
    /// after taking each engine's promise.
    /// Quitting collects these on the way out and hands the writes to the exit
    /// worker, which cannot hold a `DuplicationManager` — and taking them is what
    /// keeps an engine's own teardown from writing the same value a second time.
    pub fn take_pending_session_volume_restores(&self) -> Vec<(u32, u32)> {
        // Same shape as `update_primary_volume`: snapshot under the lock, do
        // the session writes outside of it.
        let engines: Vec<Arc<EngineShared>> = self
            .engines
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect();
        let mut pending = Vec::new();
        for engine in &engines {
            // The claim lock again, for the same reason `update_primary_volume`
            // takes it: this promise is what the exit worker hands back, and a
            // primary-volume write that landed after it would leave the mixer
            // remembering our route's value for the program's next launch with
            // no engine left to undo it. The engine goes down with the app, so
            // also raise its flag here — a write deciding under this lock then
            // finds `shutdown` set and skips, and the wakes let a parked
            // mirror or a held capture thread wind down promptly.
            let _claim = engine
                .volume_claim
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            engine.shutdown.store(true, Ordering::Relaxed);
            for mirror in &engine.mirrors {
                mirror.wake();
            }
            wake_capture(engine);
            if let Some(promise) = engine.take_restore_promise() {
                pending.push(promise);
            }
        }
        pending
    }

    /// Push a program's level to every engine running for it.
    ///
    /// Matched by executable name rather than by PID, the same ownership rule
    /// the routing assignments use: one program can hold several sessions, and
    /// its level belongs to the program.
    pub fn update_source_volume(&self, exe_name: &str, percent: u32) {
        for engine in self
            .engines
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            if engine.exe_name == exe_name {
                engine
                    .source_volume_percent
                    .store(percent, Ordering::Relaxed);
            }
        }
    }

    /// The executables this manager currently runs an engine for, each named
    /// once, sorted.
    ///
    /// One program can hold several engines (a browser holds one per window's
    /// session), and a level belongs to the program, so the caller gets programs
    /// rather than PIDs.
    pub fn routed_exe_names(&self) -> Vec<String> {
        let engines = self.engines.lock().unwrap_or_else(|e| e.into_inner());
        let mut names: Vec<String> = engines.values().map(|e| e.exe_name.clone()).collect();
        names.sort();
        names.dedup();
        names
    }

    /// The executable name of the engine running for `pid`, if one is.
    pub fn exe_name_of(&self, pid: u32) -> Option<String> {
        self.engines
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&pid)
            .map(|e| e.exe_name.clone())
    }

    /// Whether an engine other than `pid`'s is duplicating the same
    /// executable right now.
    ///
    /// The per-app endpoint assignment Windows persists is stored per
    /// executable (see the module docs of `routing.rs`), so anything that
    /// releases it through one PID takes it away from every other PID of the
    /// same program — including one whose route is still live.
    pub fn exe_duplicated_elsewhere(&self, pid: u32) -> bool {
        let engines = self.engines.lock().unwrap_or_else(|e| e.into_inner());
        let Some(engine) = engines.get(&pid) else {
            return false;
        };
        let exe = engine.exe_name.as_str();
        engines.values().any(|e| e.pid != pid && e.exe_name.eq(exe))
    }

    /// Start duplicating `pid`'s audio to `mirror_device_ids`, replacing any
    /// engine already running for the process.
    ///
    /// `primary_device_id` is the endpoint the OS plays natively; every delay is
    /// measured against it, so it has to be known by the engine (see
    /// `group_min_delay_ms`).
    ///
    /// The capture format is probed synchronously (a fast call); the
    /// process-loopback activation runs on the engine thread and reports
    /// failures through the `duplication-stopped` event with reason `error`.
    ///
    /// A stop that arrives while this is in flight is honored after the start
    /// lands: the eviction below and the registration in `starting` happen in
    /// one step under the `engines` lock, and [`stop`](Self::stop) waits that
    /// registration out before it removes.
    pub fn start(
        &self,
        pid: u32,
        exe_name: &str,
        primary_device_id: &str,
        mirror_device_ids: Vec<String>,
        app: &AppHandle,
    ) -> Result<u64, AudioError> {
        // Evict any incumbent and declare this start in flight, under one
        // acquisition of `engines`. From here to the guard's drop at the end
        // of this function, a `stop` for this pid waits rather than removing
        // nothing and letting the insertion below resurrect what it stopped.
        let _start_guard = self.begin_start(pid);
        if mirror_device_ids.is_empty() {
            return Ok(0);
        }
        if pid == 0 {
            return Err(AudioError::Api("invalid pid".to_string()));
        }

        let (format, block_align, sample_rate) = default_mix_format()?;
        validate_mix_format(block_align, sample_rate)?;
        let sample = SampleFormat::parse(&format);
        // Ring must hold the worst case pipeline a configuration can ask for:
        // the base latency plus the largest spread between the earliest and the
        // latest device, which two opposite extremes of the hard bound can
        // produce.
        let ring_capacity = sample_rate as usize
            * (LATENCY_TARGET_MS + 2 * DELAY_MAX_MS as usize + TRIM_SLACK_MS + 100)
            / 1000
            * block_align;
        let mirrors = mirror_device_ids
            .into_iter()
            .map(|device_id| {
                Arc::new(MirrorChannel {
                    delay_ms: AtomicI32::new(self.delays.get(&device_id)),
                    volume_percent: AtomicU32::new(self.volumes.get(&device_id)),
                    device_id,
                    ring: Mutex::new(VecDeque::new()),
                    capacity: ring_capacity,
                    enabled: AtomicBool::new(true),
                    wakeups: AtomicU64::new(0),
                    stream_latency_ms: AtomicU32::new(0),
                    worker: Mutex::new(None),
                })
            })
            .collect();

        let creation_time = process_creation_time(pid).unwrap_or(0);
        let shared = Arc::new(EngineShared {
            pid,
            exe_name: exe_name.to_string(),
            generation: NEXT_GENERATION.fetch_add(1, Ordering::Relaxed),
            creation_time,
            shutdown: AtomicBool::new(false),
            mirrors,
            capture_worker: Mutex::new(None),
            primary_device_id: primary_device_id.to_string(),
            primary_delay_ms: AtomicI32::new(self.delays.get(primary_device_id)),
            session_volume_percent: AtomicU32::new(self.primary_volumes.get(exe_name)),
            restore_volume_percent: AtomicU32::new(100),
            restore_volume: AtomicBool::new(false),
            volume_claim: Mutex::new(()),
            source_volume_percent: AtomicU32::new(self.sources.get(exe_name)),
            levels: self.levels.clone(),
            format,
            sample,
            block_align,
            sample_rate,
            latency_frames: sample_rate as usize * LATENCY_TARGET_MS / 1000,
            trim_slack_frames: sample_rate as usize * TRIM_SLACK_MS / 1000,
            sync_delays: AtomicBool::new(self.delay_sync.load(Ordering::Relaxed)),
            go: AtomicBool::new(false),
            ready_count: AtomicUsize::new(0),
            capture_wakeups: AtomicU64::new(0),
            started: Instant::now(),
            last_audio_ms: AtomicU64::new(0),
        });

        // Registering the engine is the moment two concurrent starts for the
        // same PID are reconciled. `stop()` ran at the top of this method, but
        // the COM work between there and here is slow enough that another
        // `start` can have slipped its own engine in: without this check the
        // loser is never told to shut down, its capture thread keeps writing
        // the program's audio to its mirrors, and the user hears the route
        // twice while its threads run until the process exits.
        let losing = {
            let mut engines = self.engines.lock().unwrap_or_else(|e| e.into_inner());
            if engines.get(&pid).map(|e| e.generation).unwrap_or(0) > shared.generation {
                // A newer engine took the seat while this start did its COM work.
                // This one never spawned a thread, so withdrawing it is clean —
                // and the caller is handed the generation of the engine that is
                // actually serving the program.
                return Ok(engines.get(&pid).map(|e| e.generation).unwrap_or(0));
            }
            // `insert` hands back whatever sat in the seat, so the eviction and
            // the registration are one atomic step. The guard ends with this
            // block: the loser is shut down outside the lock, the way `stop`
            // does it, because handing its session volume back is a round of
            // device and session enumeration and AudioSrv gets slow on a
            // Bluetooth reconnect — seconds in which every command that wants
            // `engines` would be queued behind us.
            engines.insert(pid, Arc::clone(&shared))
        };
        if let Some(losing) = losing {
            // Losing the seat is a stop like any other: shutdown, the wakes
            // that end any park, and the program's session volume back to what
            // the loser read before it claimed it.
            retire_engine(&losing);
        }

        // Claim the program's session volume for this route — only now that the
        // seat is settled, and only after the engine that held it has handed its
        // own value back. Reading the pre-route value any earlier lets a losing
        // concurrent start leave *its* write standing (it returns above without
        // a thread to restore it) and lets the winner read that write as the
        // user's own setting: the original loudness would be lost for good, and
        // `session_compensation` would divide by a percent the session is not
        // actually at, which is how a copy ends up loud by twenty times.
        //
        // What the program played at before is remembered so the route can give
        // it back on stop — a session volume that outlived the route would keep
        // the program quiet everywhere, and the volume mixer remembers the value
        // for its next launch.
        // The claim races `stop` on the other side of the same lock. Without
        // it, a stop deciding "nothing was claimed yet" could restore before
        // the promise is set, and the write below would land after it: the
        // program left at the route's loudness, with no engine and no promise,
        // and the pre-route value gone for good. Under the lock, a stop either
        // finds the promise and restores it, or this claim finds the shutdown
        // flag and never writes.
        let claim = shared
            .volume_claim
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if !shared.shutdown.load(Ordering::Relaxed) {
            if let Some(pre_route) = super::sessions::get_session_volume(pid).ok().flatten() {
                shared.restore_volume_percent.store(
                    (pre_route * 100.0).round().clamp(0.0, 100.0) as u32,
                    Ordering::Relaxed,
                );
                shared.restore_volume.store(true, Ordering::Relaxed);
            }
            let session_percent = shared.session_volume_percent.load(Ordering::Relaxed);
            let touched = super::sessions::set_session_volume(pid, session_percent as f32 / 100.0)
                .unwrap_or(0);
            if touched == 0 {
                warn!("no live session for PID {pid} — primary volume applies when it next sounds");
            }
        }
        drop(claim);

        let generation = shared.generation;
        let app = app.clone();
        let thread_shared = Arc::clone(&shared);
        if let Err(e) = std::thread::Builder::new()
            .name(format!("aar-dup-{pid}"))
            .spawn(move || capture_main(thread_shared, app))
        {
            // The engine never started, so no thread will unregister it; drop
            // the entry here or `active_routes` would report it forever.
            let outcome = self.unregister(pid, generation);
            // The predecessor this start evicted skipped its own level cleanup
            // on the promise that this engine publishes under the same key — a
            // promise the thread that never ran cannot keep. Unless a successor
            // already holds the seat: it publishes under that same key, and
            // forgetting here would drop the reading it just wrote.
            if !matches!(outcome, UnregisterOutcome::Replaced) {
                shared.levels.forget(&shared.exe_name, pid);
            }
            // And give the loudness back: the thread that owns an engine's
            // teardown is the only thing that would have, and it never ran, so
            // the program would stay quiet on every path — with the volume
            // mixer remembering our value for its next launch.
            shared.restore_session_volume();
            return Err(AudioError::Api(format!("spawn capture thread failed: {e}")));
        }
        Ok(generation)
    }

    /// Signal the engine for `pid` to stop. Threads clean up asynchronously.
    ///
    /// A start still in flight for `pid` lands first: this waits for it, then
    /// removes what it inserted. Returning before that would let the stop
    /// remove nothing while an engine was mid-COM-work, and the late insertion
    /// would play a stopped route's audio to mirrors the board no longer shows.
    /// The wait is bounded by one start's slow path (format probe and session
    /// claim), and callers already run `stop` off the main thread.
    pub fn stop(&self, pid: u32) {
        self.starting.wait_for_quiet(pid);
        self.evict(pid);
    }

    /// Remove `pid`'s engine, if one is seated, and take it down — without
    /// waiting on an in-flight start. Public callers want [`stop`](Self::stop);
    /// `begin_start` is the only caller that must not wait (it *is* the start).
    fn evict(&self, pid: u32) {
        let engine = self
            .engines
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&pid);
        if let Some(shared) = engine {
            retire_engine(&shared);
        }
    }

    /// Evict `pid`'s incumbent and register this start in one step, so a stop
    /// that arrives from here on waits for this start to land instead of
    /// removing nothing beneath it. The incumbent is retired outside the lock,
    /// the way `stop` does it: handing its session volume back is a round of
    /// device and session enumeration, and AudioSrv gets slow on a Bluetooth
    /// reconnect — seconds in which every command that wants `engines` would
    /// be queued behind us.
    fn begin_start(&self, pid: u32) -> StartGuard<'_> {
        let incumbent = {
            let mut engines = self.engines.lock().unwrap_or_else(|e| e.into_inner());
            // Lock order: `engines` before `starting`, everywhere. The two
            // `StartRegistry` methods that take only its own lock never reach
            // for `engines`, and `volume_claim` is only ever a leaf.
            self.starting.begin(pid);
            engines.remove(&pid)
        };
        if let Some(shared) = incumbent {
            retire_engine(&shared);
        }
        StartGuard {
            registry: &self.starting,
            pid,
        }
    }

    /// Live engines with the exact ordered device list they are serving.
    pub fn active_routes(&self) -> Vec<ActiveRoute> {
        let engines = self.engines.lock().unwrap_or_else(|e| e.into_inner());
        let mut routes: Vec<ActiveRoute> = engines
            .values()
            .map(|engine| {
                // Only the mirrors that are still in service. A mirror that
                // failed to open, or that errored later, is not a route target:
                // reporting it as one puts its badge, its success dot and its
                // pulse ring back on the stage for a device that is producing
                // nothing, and hides the one report the user got about it. The
                // frontend cannot recover this on its own — the failure arrives
                // as an event, and it is this list that would overwrite it.
                let mirrors: Vec<&Arc<MirrorChannel>> = engine
                    .mirrors
                    .iter()
                    .filter(|m| m.enabled.load(Ordering::Relaxed))
                    .collect();
                ActiveRoute {
                    pid: engine.pid,
                    generation: engine.generation,
                    device_ids: std::iter::once(engine.primary_device_id.clone())
                        .chain(mirrors.iter().map(|m| m.device_id.clone()))
                        .collect(),
                    // Same order, same length: the primary heads the list and is
                    // the one entry this engine cannot answer for.
                    latency_ms: std::iter::once(None)
                        .chain(mirrors.iter().map(|m| total_latency_ms(engine, m)))
                        .collect(),
                }
            })
            .collect();
        routes.sort_by_key(|route| route.pid);
        routes
    }

    /// Remove `pid`'s engine unless a newer engine replaced it. Called by the
    /// engine's own capture thread on exit; [`UnregisterOutcome::Current`] is
    /// what makes its own teardown steps (the session-volume restore) safe to
    /// run.
    fn unregister(&self, pid: u32, generation: u64) -> UnregisterOutcome {
        let mut engines = self.engines.lock().unwrap_or_else(|e| e.into_inner());
        match engines.get(&pid).map(|e| e.generation) {
            Some(g) if g == generation => {
                engines.remove(&pid);
                UnregisterOutcome::Current
            }
            Some(_) => UnregisterOutcome::Replaced,
            None => UnregisterOutcome::Empty,
        }
    }
}

/// What [`DuplicationManager::unregister`] found in the seat.
enum UnregisterOutcome {
    /// This engine was still the one serving `pid`; it left the map with this
    /// call.
    Current,
    /// A newer engine serves `pid` now.
    Replaced,
    /// No engine serves `pid` — `stop` already removed this one.
    Empty,
}

/// Entry point of an engine's capture thread.
fn capture_main(shared: Arc<EngineShared>, app: AppHandle) {
    let reason = run_capture(&shared, &app);
    // `capture_session` sets this itself before it joins; this covers the paths
    // that failed before any render thread existed, so no exit route can leave
    // the flag unset.
    shared.shutdown.store(true, Ordering::Relaxed);
    match &reason {
        ExitReason::Stopped => info!(
            "duplication for PID {} stopped ({} mirrors)",
            shared.pid,
            shared.mirrors.len()
        ),
        ExitReason::ProcessExited => {
            info!("duplication for PID {} ended: process exited", shared.pid)
        }
        ExitReason::Error(e) => warn!("duplication for PID {} failed: {e}", shared.pid),
        // Unreachable: `capture_session` converts it into the reason the hold
        // ended before returning. Kept so the match says which one it is.
        ExitReason::AllMirrorsLost => {}
    }
    let mirror_wakes: u64 = shared
        .mirrors
        .iter()
        .map(|m| m.wakeups.load(Ordering::Relaxed))
        .sum();
    info!(
        "engine for PID {} ran {:?}: {} capture waits, {} mirror waits",
        shared.pid,
        shared.started.elapsed(),
        shared.capture_wakeups.load(Ordering::Relaxed),
        mirror_wakes
    );
    let outcome = app
        .state::<DuplicationManager>()
        .unregister(shared.pid, shared.generation);
    // An engine that died on its own error leaves the program playing at the
    // session volume this route claimed — give it back, unless the process
    // (and with it the session) is gone. A clean `Stopped` exit was already
    // restored synchronously by `stop`, and restoring again here could clobber
    // a successor engine's freshly claimed volume.
    if matches!(outcome, UnregisterOutcome::Current) && matches!(reason, ExitReason::Error(_)) {
        shared.restore_session_volume();
    }
    // The level table holds one entry per engine, and this engine will publish
    // no more — `run_capture` has returned — so a `Current` or `Empty` exit
    // leaves its entry orphaned for the life of the process unless it goes
    // now. A `Replaced` exit is the successor's seat: the successor publishes
    // under the same key.
    if !matches!(outcome, UnregisterOutcome::Replaced) {
        shared.levels.forget(&shared.exe_name, shared.pid);
    }
    let _ = app.emit(
        "duplication-stopped",
        json!({
            "pid": shared.pid,
            "generation": shared.generation,
            "reason": reason.event_name(),
            "error": reason.error_message(),
        }),
    );
}

/// Activate the capture client and pump captured frames into the mirror rings.
fn run_capture(shared: &Arc<EngineShared>, app: &AppHandle) -> ExitReason {
    let com_owned = match crate::audio::init_com() {
        Ok(owned) => owned,
        Err(e) => return ExitReason::Error(e),
    };
    let result = capture_loop(shared, app);
    crate::audio::uninit_com(com_owned);
    result
}

fn capture_loop(shared: &Arc<EngineShared>, app: &AppHandle) -> ExitReason {
    match capture_stream(shared, app) {
        Ok(reason) => reason,
        Err(e) => ExitReason::Error(e),
    }
}

fn capture_stream(shared: &Arc<EngineShared>, app: &AppHandle) -> Result<ExitReason, AudioError> {
    let com_err =
        |what: &str, e: windows::core::Error| AudioError::Api(format!("{what} failed: {e}"));
    let client = activate_process_loopback(shared.pid)?;
    if shared.shutdown.load(Ordering::Relaxed) {
        return Ok(ExitReason::Stopped);
    }

    let event = unsafe {
        // SAFETY: no security attributes, unnamed auto-reset event; closed below
        // once the client that was driven by it is gone.
        CreateEventW(None, false, false, None).map_err(|e| com_err("CreateEventW", e))?
    };
    // The client is moved in so that every path — including the ones that fail
    // before the stream ever started — releases it before this closes the event
    // handle it was given.
    let result = capture_session(shared, client, event, app);
    // SAFETY: balances CreateEventW above; no client references the handle now.
    unsafe {
        let _ = CloseHandle(event);
    }
    result
}

/// Initialize the capture client, run one render thread per mirror, and pump
/// frames between them until the engine is over.
fn capture_session(
    shared: &Arc<EngineShared>,
    client: IAudioClient,
    event: HANDLE,
    app: &AppHandle,
) -> Result<ExitReason, AudioError> {
    let com_err =
        |what: &str, e: windows::core::Error| AudioError::Api(format!("{what} failed: {e}"));
    // SAFETY: format is a complete WAVEFORMATEX(EXTENSIBLE) copied from the
    // default device's mix format.
    let format = unsafe { &*(shared.format.as_ptr() as *const WAVEFORMATEX) };
    // SAFETY: shared-mode event-driven process loopback; periodicity must be 0
    // in shared mode. AUTOCONVERTPCM lets the requested format differ from the
    // engine mix; if loopback capture rejects the conversion path, retry with
    // the plain mix format.
    unsafe {
        client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK
                    | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                    | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                    | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                STREAM_BUFFER_DURATION,
                0,
                format,
                None,
            )
            .or_else(|_| {
                client.Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                    STREAM_BUFFER_DURATION,
                    0,
                    format,
                    None,
                )
            })
            .map_err(|e| com_err("Initialize(capture)", e))?;
    }
    // SAFETY: valid handle; the client is event-driven so the handle must stay
    // valid for the lifetime of the stream. Must come after Initialize.
    if let Err(e) = unsafe { client.SetEventHandle(event) } {
        return Err(com_err("SetEventHandle", e));
    }
    // SAFETY: GetService on a fully initialized capture client.
    let capture: IAudioCaptureClient = unsafe {
        client
            .GetService()
            .map_err(|e| com_err("GetService(IAudioCaptureClient)", e))?
    };
    // SAFETY: Start on a fully initialized capture client.
    if let Err(e) = unsafe { client.Start() } {
        return Err(com_err("Start(capture)", e));
    }

    // Each handle paired with its mirror: a thread that dies in a panic
    // reports through the mirror's own failure channel, not into the void.
    let mut render_threads: Vec<(Arc<MirrorChannel>, std::thread::JoinHandle<()>)> =
        Vec::with_capacity(shared.mirrors.len());
    for mirror in &shared.mirrors {
        let thread_shared = shared.clone();
        let thread_app = app.clone();
        let thread_mirror = mirror.clone();
        let spawned = std::thread::Builder::new()
            .name(format!("aar-render-{}", shared.pid))
            .spawn(move || render_main(thread_shared, thread_mirror, thread_app));
        match spawned {
            Ok(handle) => render_threads.push((mirror.clone(), handle)),
            Err(e) => {
                // The OS refused the thread. Spawning with `thread::spawn`
                // would panic here, and the unwind would tear this capture
                // thread down past every teardown step that follows the
                // capture loop: the engine would stay registered, its mirrors
                // keep their devices open and no stopped event would fire.
                // Take the mirror out of service the way a render thread that
                // lost its device would be, and count it ready, or the start
                // gate waits out its backstop on a report that never comes.
                fail_mirror(
                    shared,
                    mirror,
                    app,
                    AudioError::Api(format!("spawn render thread failed: {e}")),
                );
                mirror_ready(shared, app);
            }
        }
    }

    let mut gate = StartGate {
        opened_at: Instant::now(),
        opened: false,
    };
    let mut reason = capture_packets(shared, &capture, event, &mut gate);
    if matches!(reason, ExitReason::AllMirrorsLost) {
        // The last copy is out of service: nothing on the device side of this
        // engine can make a sound any more, and a started event-driven capture
        // client keeps the endpoint signalling a thread with no consumer.
        // Release the tap for good, then hold the engine registered — stopping
        // it here would emit `duplication-stopped` and take the still-working
        // primary route down with it. The outcome is reported as what it is:
        // the mirrors each failed on their own events, and `active_routes`
        // shows this engine on the primary alone.
        // SAFETY: Stop on a started client; errors are not actionable, the
        // client is being dropped either way.
        unsafe {
            let _ = client.Stop();
        }
        drop(capture);
        drop(client);
        reason = hold_after_lost_copies(shared);
        shared.shutdown.store(true, Ordering::Relaxed);
        for mirror in &shared.mirrors {
            mirror.wake();
        }
        // No client to stop a second time: it is gone, which was the point.
        join_render_threads(shared, app, render_threads);
        return Ok(reason);
    }
    // Release the render threads before waiting for them. This flag is the only
    // thing `pump_render` returns on, and a process exit or a capture error ends
    // the loop above without `stop()` ever having been called — joining first
    // would wait forever on threads that are happily playing silence, leaking the
    // engine, its threads and the mirror devices they hold open.
    shared.shutdown.store(true, Ordering::Relaxed);
    // Wake the render threads for the same reason the registry does when a
    // route is stopped: one of them may be parked on a quiet source, waiting on
    // its own thread, and this thread is about to join it.
    for mirror in &shared.mirrors {
        mirror.wake();
    }
    // SAFETY: Stop on a started client; errors during shutdown are ignored.
    unsafe {
        let _ = client.Stop();
    }
    join_render_threads(shared, app, render_threads);
    Ok(reason)
}

/// Tracks whether the synchronized-start gate has been opened.
struct StartGate {
    opened_at: Instant,
    opened: bool,
}

/// Delay of the earliest device of the group, in milliseconds.
///
/// Every device carries its own delay measured against the app's audio as
/// captured, but only the earliest one can stay where it is: the OS plays the
/// primary device natively and software delay can only be added, never removed.
/// That earliest device is therefore the group's reference and every other
/// device is held back by the difference (see `target_frames`). The route is
/// ordered so the primary is normally the minimum, but a delay lowered while
/// the engine runs can briefly move the reference to a mirror — which simply
/// shifts the group instead of glitching.
fn group_min_delay_ms(shared: &EngineShared) -> i32 {
    shared
        .mirrors
        .iter()
        .filter(|m| m.enabled.load(Ordering::Relaxed))
        .map(|m| m.delay_ms.load(Ordering::Relaxed))
        .chain(std::iter::once(
            shared.primary_delay_ms.load(Ordering::Relaxed),
        ))
        .min()
        .unwrap_or(0)
}

/// Volume of the loudest *copy* in the group, which is the level every other
/// mirror is scaled against.
///
/// Software gain attenuates but never boosts, so the loudest mirror stays
/// where the app put it and the rest are brought down towards it. The primary
/// is deliberately not in the reference: its loudness is the program's session
/// volume (`session_volume_percent`) — a property of the program, and the one
/// thing about the primary that *can* move — while a mirror's share stays a
/// property of the device. Mixing the two into one reference would make every
/// mirror chase a number a session-volume change moves without any mirror
/// click. Mirrors that failed to open are ignored, exactly as they are for
/// delays. Floored at 1 so an all-zero group stays a valid (silent) division.
fn group_max_volume(shared: &EngineShared) -> u32 {
    shared
        .mirrors
        .iter()
        .filter(|m| m.enabled.load(Ordering::Relaxed))
        .map(|m| m.volume_percent.load(Ordering::Relaxed))
        .max()
        .unwrap_or(100)
        .max(1)
}

/// Gain that undoes the program's session volume on the copies.
///
/// The loopback tap sits behind the session volume, so lowering it lowers what
/// the mirrors receive too — and with it everything the copies would play.
/// Dividing their gain by the same factor puts the copies back exactly where
/// they were, which is what makes the primary's volume control move the
/// primary path alone: in a mirror's arithmetic the session volume cancels,
/// and in the primary's path it is the whole change. The percentage is
/// floored at [`crate::config::PRIMARY_VOLUME_MIN_PERCENT`], both because the
/// stored value is clamped there and so an out-of-band zero can never divide.
fn session_compensation(shared: &EngineShared) -> f32 {
    let percent = shared
        .session_volume_percent
        .load(Ordering::Relaxed)
        .max(crate::config::PRIMARY_VOLUME_MIN_PERCENT) as f32;
    100.0 / percent
}

/// Gain to apply to `mirror`'s frames: its own share of the group's loudest
/// device, i.e. 1.0 when it is the loudest one (or the only one left).
fn volume_gain(shared: &EngineShared, mirror: &MirrorChannel) -> f32 {
    let own = mirror.volume_percent.load(Ordering::Relaxed);
    // The group max re-reads every share, so a volume change that lands
    // between the two loads can hand back a max below `own` — a gain above
    // 1.0, one chunk at clip level, from an arithmetic that may only ever
    // attenuate. `own` is part of that group, so a legit max is never smaller;
    // the floor says so.
    own as f32 / group_max_volume(shared).max(own) as f32
}

/// Gain for the program's own audio, from its persisted level.
///
/// This is the only gain in this module that may exceed 1.0. A device's share of
/// its group can only attenuate, because that device has a hardware volume above
/// the software one that can be turned up; a program's audio has nothing above
/// it, so raising a quiet program to the level of its neighbours means
/// amplifying it. See `SOURCE_VOLUME_MAX` for the ceiling and why it is there.
fn source_gain(shared: &EngineShared) -> f32 {
    shared.source_volume_percent.load(Ordering::Relaxed) as f32 / 100.0
}

/// Frames this mirror keeps buffered between the capture tap and playback: the
/// base latency plus how far its own delay sits above the earliest device in
/// the group. All mirrors holding their own target means they all play the same
/// capture position at the same time, offset by exactly the delays that were
/// configured for them.
fn target_frames(shared: &EngineShared, mirror: &MirrorChannel) -> usize {
    if !shared.sync_delays.load(Ordering::Relaxed) {
        return shared.latency_frames;
    }
    let offset_ms = mirror.delay_ms.load(Ordering::Relaxed) - group_min_delay_ms(shared);
    let offset_frames = shared.sample_rate as usize * offset_ms.max(0) as usize / 1000;
    shared.latency_frames + offset_frames
}

/// The software-side latency `mirror` is playing at, in milliseconds: the
/// pipeline it holds between the capture tap and the endpoint, which is the
/// engine's base latency plus this device's delay compensation (see
/// `target_frames`), plus what the endpoint reports as its own.
///
/// `None` when the endpoint never reported a latency, so a device that was
/// never measured is not drawn with a confident-looking number. Whatever a
/// hardware codec or a Bluetooth link adds on top of this is not observable
/// from user mode and is deliberately not guessed at.
fn total_latency_ms(shared: &EngineShared, mirror: &MirrorChannel) -> Option<u32> {
    let stream_ms = mirror.stream_latency_ms.load(Ordering::Relaxed);
    if stream_ms == 0 {
        return None;
    }
    let rate = shared.sample_rate.max(1) as u64;
    let pipeline_ms = (target_frames(shared, mirror) as u64 * 1000 / rate) as u32;
    Some(pipeline_ms.saturating_add(stream_ms))
}

/// Open the start gate once every mirror is initialized and holds one base
/// pipeline of pre-roll, or after the timeout (a silent app never fills it, and
/// starting un-synced while silence plays is harmless).
///
/// Only the *base* latency is required, not each mirror's full target: a
/// delay is realized by silence placed ahead of the mirror's audio (see
/// `pump_render`), which needs no captured history, so a large configured
/// delay never stalls the start.
fn open_gate_when_ready(shared: &Arc<EngineShared>, gate: &mut StartGate) {
    if gate.opened {
        return;
    }
    let pre_roll = shared.latency_frames * shared.block_align;
    let all_ready = shared.ready_count.load(Ordering::Relaxed) == shared.mirrors.len();
    let all_filled = all_ready
        && shared
            .mirrors
            .iter()
            .filter(|m| m.enabled.load(Ordering::Relaxed))
            .all(|m| m.buffered_bytes() >= pre_roll);
    if all_filled || gate.opened_at.elapsed() >= PRE_ROLL_TIMEOUT {
        gate.opened = true;
        shared.go.store(true, Ordering::Relaxed);
        // The mirrors wait on their own threads rather than polling this flag,
        // so setting it is not by itself enough to release them: without the
        // wake each would sit out the rest of its backstop before starting.
        for mirror in &shared.mirrors {
            mirror.wake();
        }
        info!(
            "duplication for PID {} started, pre-roll took {:?}",
            shared.pid,
            gate.opened_at.elapsed()
        );
    }
}

/// Drain capture packets until shutdown, error, or process exit.
fn capture_packets(
    shared: &Arc<EngineShared>,
    capture: &IAudioCaptureClient,
    event: HANDLE,
    gate: &mut StartGate,
) -> ExitReason {
    match capture_packets_inner(shared, capture, event, gate) {
        Ok(reason) => reason,
        Err(e) => ExitReason::Error(e),
    }
}

fn capture_packets_inner(
    shared: &Arc<EngineShared>,
    capture: &IAudioCaptureClient,
    event: HANDLE,
    gate: &mut StartGate,
) -> Result<ExitReason, AudioError> {
    let com_err =
        |what: &str, e: windows::core::Error| AudioError::Api(format!("{what} failed: {e}"));
    // One estimate per engine, folded from the packets as they arrive and
    // published on a schedule. Owned here because this thread is its only
    // writer, and kept across packets because a level is a running measurement.
    let mut level = LevelTracker::default();
    loop {
        // SAFETY: valid event handle owned by this thread.
        let wait = unsafe { WaitForSingleObject(event, CAPTURE_WAIT_MS) };
        shared.capture_wakeups.fetch_add(1, Ordering::Relaxed);
        if shared.shutdown.load(Ordering::Relaxed) {
            return Ok(ExitReason::Stopped);
        }
        open_gate_when_ready(shared, gate);
        if shared.all_mirrors_lost() {
            // Every mirror is out of service: the pump has nothing left to
            // feed, and pumping keeps the loopback endpoint busy for copies
            // that will never wake up. Hand over to the hold (see
            // `capture_session`), which releases the client without taking
            // the primary route down.
            return Ok(ExitReason::AllMirrorsLost);
        }
        if wait == WAIT_TIMEOUT {
            // The loopback event only fires while the process actually plays
            // audio; use idle timeouts to notice process exit.
            if !process_alive(shared.pid, shared.creation_time) {
                return Ok(ExitReason::ProcessExited);
            }
            continue;
        }

        loop {
            // SAFETY: packet query on a started capture client.
            let packet = unsafe {
                capture
                    .GetNextPacketSize()
                    .map_err(|e| com_err("GetNextPacketSize", e))?
            };
            if packet == 0 {
                break;
            }
            let mut data: *mut u8 = std::ptr::null_mut();
            let mut frames = 0u32;
            let mut flags = 0u32;
            // SAFETY: out params; the buffer is valid until ReleaseBuffer.
            if let Err(e) =
                unsafe { capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None) }
            {
                return Err(com_err("GetBuffer(capture)", e));
            }
            if frames > 0 && flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 == 0 {
                let bytes = frames as usize * shared.block_align;
                // SAFETY: GetBuffer guarantees `bytes` writable bytes.
                let chunk = unsafe { std::slice::from_raw_parts(data, bytes) };
                // Measured before the push and outside the ring, and published
                // in what the program produced (`measure_into`) rather than
                // what any one device was handed after its own gains.
                measure_into(&mut level, shared, chunk, frames);
                // Timestamp first, then the push, then the wake: a mirror that
                // runs on either of the last two must not conclude the source
                // is quiet on the strength of the packet it is already holding.
                note_audio(shared);
                for mirror in &shared.mirrors {
                    mirror.push(chunk, shared.block_align);
                    mirror.wake();
                }
            }
            // SAFETY: balances GetBuffer with the number of frames read.
            if let Err(e) = unsafe { capture.ReleaseBuffer(frames) } {
                return Err(com_err("ReleaseBuffer(capture)", e));
            }
        }
    }
}

/// Entry point of one mirror's render thread.
fn render_main(shared: Arc<EngineShared>, mirror: Arc<MirrorChannel>, app: AppHandle) {
    let com_owned = match crate::audio::init_com() {
        Ok(owned) => owned,
        Err(e) => {
            fail_mirror(&shared, &mirror, &app, e);
            // A failed mirror must not hold the synchronized-start gate open.
            mirror_ready(&shared, &app);
            return;
        }
    };

    match open_render_session(&shared, &mirror) {
        Ok(session) => {
            mirror_ready(&shared, &app);
            render_run(&shared, &mirror, session, &app);
        }
        Err(e) => {
            fail_mirror(&shared, &mirror, &app, e);
            mirror_ready(&shared, &app);
        }
    }

    crate::audio::uninit_com(com_owned);
}

/// Count one mirror as initialized and, when the last one is in, tell the
/// frontend the engine has something to report.
///
/// A mirror asks its endpoint for the endpoint's own stream latency while it
/// initializes, so until this point the reading is not missing by accident, it
/// simply does not exist yet. `apply_route` has answered long before any of this
/// (the render threads are spawned behind an asynchronous device activation), so
/// without this event the frontend would read an empty reading — and keep it,
/// because nothing else asks again until some later, unrelated action.
fn mirror_ready(shared: &EngineShared, app: &AppHandle) {
    let previous = shared.ready_count.fetch_add(1, Ordering::Relaxed);
    if previous + 1 != shared.mirrors.len() {
        return;
    }
    let _ = app.emit(
        "duplication-ready",
        json!({
            "pid": shared.pid,
            "generation": shared.generation,
        }),
    );
}

/// Take one mirror out of service and tell the frontend why.
///
/// The engine keeps running for the devices that did open, so nothing else
/// reports this — and a `warn!` in a release build goes to a stderr the window
/// subsystem discards. Without the event a route that lost one of its targets
/// still shows as fully applied, which is indistinguishable from the app being
/// broken: the second device is silent and there is nothing on screen to say so.
fn fail_mirror(shared: &EngineShared, mirror: &MirrorChannel, app: &AppHandle, error: AudioError) {
    warn!("mirror device {} failed: {error}", mirror.device_id);
    mirror.enabled.store(false, Ordering::Relaxed);
    let _ = app.emit(
        "duplication-mirror-failed",
        json!({
            "pid": shared.pid,
            "generation": shared.generation,
            "deviceId": mirror.device_id,
            "error": error.to_string(),
        }),
    );
}

/// Wait without the loopback client for as long as every copy is dead.
///
/// An engine whose mirrors have all failed would otherwise keep the loopback
/// tap alive forever — and a plain engine stop is not an option either,
/// because `duplication-stopped` takes the whole route, the still-playing
/// primary included, off the board. So the thread waits, cheap and registered,
/// until the route ends by itself: a user stop, or the program's exit.
///
/// What wakes it: a stop or re-route of this program sets the shutdown flag
/// and calls [`wake_capture`], the same token semantics every other park in
/// this module uses; the `CAPTURE_WAIT_MS` timeout is only the backstop for a
/// wakeup that never arrives, and doubles as the idle engine's liveness check
/// — the same one poll per two seconds a quiet-but-serving engine already
/// pays. Nothing else can wake it, and nothing else should: the mirrors are
/// dead and no packet revives them.
fn hold_after_lost_copies(shared: &EngineShared) -> ExitReason {
    *shared
        .capture_worker
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(std::thread::current());
    warn!(
        "duplication for PID {} lost every copy: the route plays on the primary alone",
        shared.pid
    );
    loop {
        if shared.shutdown.load(Ordering::Relaxed) {
            return ExitReason::Stopped;
        }
        if !process_alive(shared.pid, shared.creation_time) {
            return ExitReason::ProcessExited;
        }
        // The park is armed before the next pass of the checks, so a stop that
        // lands between a check and the park leaves its token here and the
        // park returns at once.
        std::thread::park_timeout(Duration::from_millis(CAPTURE_WAIT_MS as u64));
    }
}

/// Join every mirror's render thread, reporting the ones that died in a panic.
///
/// The join result used to be ignored on the theory that render threads
/// report their own failures through `enabled` — true, until one panics (a
/// frame-arithmetic divide, say) and unwinds past every report: the mirror
/// stays enabled, its ring grows with nobody popping, the board shows a copy
/// playing that has no thread behind it, and nothing is logged. A panicked
/// join now says so, and takes the mirror out of service through the same
/// channel its clean failures use.
fn join_render_threads(
    shared: &EngineShared,
    app: &AppHandle,
    render_threads: Vec<(Arc<MirrorChannel>, std::thread::JoinHandle<()>)>,
) {
    for (mirror, handle) in render_threads {
        if let Err(payload) = handle.join() {
            let detail = payload
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "panic without a message".to_string());
            fail_mirror(
                shared,
                &mirror,
                app,
                AudioError::Api(format!("render thread panicked: {detail}")),
            );
        }
    }
}

/// A kernel event handle that closes itself unless somebody takes ownership.
///
/// It exists for the window between `CreateEventW` and the session that is
/// supposed to own the handle: `Initialize`, `SetEventHandle`, `GetService` and
/// `GetBufferSize` all sit in that window and all can fail, and each failure
/// used to leave the handle open for the life of the app — one per mirror, per
/// retry, on a tray-resident process whose devices come and go. On the success
/// path `std::mem::forget` disarms it, and `RenderSession`'s own `Drop` closes
/// the handle exactly once, as it always has.
struct EventGuard(HANDLE);

impl Drop for EventGuard {
    fn drop(&mut self) {
        // SAFETY: this guard is the only owner, and the handle it holds came
        // from CreateEventW. A session that took the handle forgot this guard,
        // so no path closes the same handle twice.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

/// A fully initialized render client, not yet started.
struct RenderSession {
    client: IAudioClient,
    render: IAudioRenderClient,
    event: HANDLE,
    buffer_frames: usize,
}

impl Drop for RenderSession {
    fn drop(&mut self) {
        // SAFETY: balances CreateEventW in open_render_session.
        unsafe {
            let _ = CloseHandle(self.event);
        }
    }
}

/// Open and initialize one mirror's render client, without starting it.
fn open_render_session(
    shared: &EngineShared,
    mirror: &MirrorChannel,
) -> Result<RenderSession, AudioError> {
    let com_err =
        |what: &str, e: windows::core::Error| AudioError::Api(format!("{what} failed: {e}"));
    let device_id = mirror.device_id.clone();
    let enumerator: IMMDeviceEnumerator = unsafe {
        // SAFETY: MMDeviceEnumerator is the registered coclass.
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .map_err(|e| com_err("CoCreateInstance", e))?
    };
    let wide: Vec<u16> = device_id.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: wide is NUL-terminated and outlives the call.
    let device = unsafe {
        enumerator
            .GetDevice(PCWSTR(wide.as_ptr()))
            .map_err(|e| com_err("GetDevice", e))?
    };
    // SAFETY: activating IAudioClient on an active render device.
    let client: IAudioClient = unsafe {
        device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| com_err("Activate(IAudioClient)", e))?
    };
    let event = unsafe {
        // SAFETY: unnamed auto-reset event; owned by RenderSession.
        CreateEventW(None, false, false, None).map_err(|e| com_err("CreateEventW", e))?
    };
    let guard = EventGuard(event);
    // SAFETY: format is a complete WAVEFORMATEX(EXTENSIBLE) copied from the
    // default device's mix format; auto-convert adapts it to this device.
    let format = unsafe { &*(shared.format.as_ptr() as *const WAVEFORMATEX) };
    // SAFETY: shared-mode event-driven render; periodicity must be 0.
    // AUTOCONVERTPCM lets the shared capture format stand in for this device's
    // own engine mix; an endpoint that rejects the conversion path still works
    // without it, so fall back exactly as the capture side does — a mirror that
    // fails to initialize is a device the user hears nothing from.
    unsafe {
        client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                    | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                    | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                STREAM_BUFFER_DURATION,
                0,
                format,
                None,
            )
            .or_else(|_| {
                client.Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                    STREAM_BUFFER_DURATION,
                    0,
                    format,
                    None,
                )
            })
            .map_err(|e| com_err("Initialize(render)", e))?;
        client
            .SetEventHandle(event)
            .map_err(|e| com_err("SetEventHandle(render)", e))?;
    }
    let render: IAudioRenderClient = unsafe {
        client
            .GetService()
            .map_err(|e| com_err("GetService(IAudioRenderClient)", e))?
    };
    // SAFETY: GetBufferSize on an initialized client; frames are in units of
    // the requested (capture) format, matching the ring buffers.
    let buffer_frames = unsafe {
        client
            .GetBufferSize()
            .map_err(|e| com_err("GetBufferSize", e))?
    } as usize;
    // SAFETY: GetStreamLatency on an initialized client; it reports in 100 ns
    // units how far ahead of the hardware this client's frames are queued, i.e.
    // the endpoint's own contribution to the total.
    match unsafe { client.GetStreamLatency() } {
        // Not clamped upwards: a value this large would mean the endpoint is
        // already broken, and reporting it beats reporting a plausible lie.
        Ok(hns) => mirror.stream_latency_ms.store(
            (hns / 10_000).clamp(0, u32::MAX as i64) as u32,
            Ordering::Relaxed,
        ),
        Err(e) => warn!("GetStreamLatency failed for {}: {e}", mirror.device_id),
    }
    // The session takes the handle with it; disarming the guard here is what
    // keeps the close to exactly once.
    std::mem::forget(guard);
    Ok(RenderSession {
        client,
        render,
        event,
        buffer_frames,
    })
}

/// Wait for the synchronized-start gate, then run the render loop.
fn render_run(
    shared: &EngineShared,
    mirror: &MirrorChannel,
    session: RenderSession,
    app: &AppHandle,
) {
    // Publish this thread before the first of the two waits that can park it.
    // The gate below and the idle park in the render loop are both ended by a
    // wake aimed at this thread, so it has to be reachable by the time either
    // can block; a wake arriving earlier leaves a token that the next park
    // consumes instead of blocking, and each wait re-checks its condition
    // afterwards, so no wakeup is lost.
    *mirror.worker.lock().unwrap_or_else(|e| e.into_inner()) = Some(std::thread::current());
    // A slow device (e.g. Bluetooth connecting for the first time) holds the
    // gate closed; the other mirrors wait for it instead of running ahead.
    // Waiting on the thread rather than polling: this window is bounded by the
    // pre-roll timeout, and a polling loop spends it waking five hundred times
    // a second per mirror to re-read a flag that has not changed.
    while !shared.go.load(Ordering::Relaxed) {
        if shared.shutdown.load(Ordering::Relaxed) {
            return;
        }
        std::thread::park_timeout(GATE_POLL);
    }
    if shared.shutdown.load(Ordering::Relaxed) {
        return;
    }
    // SAFETY: Start on a fully initialized client.
    if let Err(e) = unsafe { session.client.Start() } {
        fail_mirror(
            shared,
            mirror,
            app,
            AudioError::Api(format!("Start(render) failed: {e}")),
        );
        return;
    }

    let result = pump_render(shared, mirror, &session);
    // SAFETY: Stop on a started client; errors during shutdown are ignored.
    unsafe {
        let _ = session.client.Stop();
    }
    if let Err(e) = result {
        fail_mirror(shared, mirror, app, e);
    }
}

/// Event-driven render cycle.
///
/// Every mirror keeps a backlog (device buffer + ring) of its own target
/// between the capture tap and playback — the shared base latency plus the
/// group shift plus its delay compensation (see `target_frames`) — so all
/// mirrors play the same sample at the same moment, offset by exactly the
/// configured delays. A device whose clock runs slow crosses the trim
/// threshold and drops its oldest frames by the drift amount; a fast device
/// briefly writes silence instead. Hardware latency (e.g. a Bluetooth codec's
/// buffer) adds on top of this and is outside software control.
fn pump_render(
    shared: &EngineShared,
    mirror: &MirrorChannel,
    session: &RenderSession,
) -> Result<(), AudioError> {
    let com_err =
        |what: &str, e: windows::core::Error| AudioError::Api(format!("{what} failed: {e}"));
    // Reused across cycles so the render thread allocates nothing per period;
    // local to this thread and cleared on every pop, so a park in between
    // cannot carry stale frames into the next device buffer.
    let mut chunk: Vec<u8> = Vec::new();
    loop {
        // SAFETY: valid event handle owned by this thread.
        let wait = unsafe { WaitForSingleObject(session.event, RENDER_WAIT_MS) };
        mirror.wakeups.fetch_add(1, Ordering::Relaxed);
        if shared.shutdown.load(Ordering::Relaxed) {
            return Ok(());
        }
        // Nothing buffered and nothing arriving: stop feeding the device, which
        // is the only way to stop it signalling this thread every period. The
        // pipeline is empty, so the device is playing the silence that was
        // written into it, and stopping is silent too.
        if mirror.buffered_bytes() == 0 && mirror_quiet(shared, mirror) {
            park_mirror(shared, mirror, session)?;
            if shared.shutdown.load(Ordering::Relaxed) {
                return Ok(());
            }
            continue;
        }
        if wait == WAIT_TIMEOUT {
            continue;
        }
        // SAFETY: padding query on a started render client.
        let padding = unsafe {
            session
                .client
                .GetCurrentPadding()
                .map_err(|e| com_err("GetCurrentPadding", e))?
        } as usize;
        let target = target_frames(shared, mirror);
        // Settle the backlog on its target *before* handing frames to the
        // device. The total (device buffer + ring) is unchanged by the hand-off,
        // so correcting first is equivalent to correcting afterwards — except
        // that a shortfall is then made up with silence placed *ahead* of the
        // audio, which is what a delay means. Correcting afterwards would play
        // the audio early and the silence late, so a raised delay (or an
        // under-filled pre-roll) would not take effect until the next buffer.
        let total = padding + mirror.buffered_bytes() / shared.block_align;
        if total > target + shared.trim_slack_frames {
            // Writes are capped at the target, so padding never exceeds it and
            // the excess always fits inside the ring.
            mirror.drop_oldest(total - target, shared.block_align);
        } else if total < target {
            mirror.prepend_silence(target - total, shared.block_align);
        }
        let free = session.buffer_frames.saturating_sub(padding);
        let allowed = target.saturating_sub(padding).min(free);
        if allowed > 0 {
            mirror.pop(allowed, shared.block_align, &mut chunk);
            if chunk.is_empty() {
                // The pipeline ran dry (fast clock or a silent source); keep
                // the engine fed with silence until data returns. This must run
                // even when the device buffer already holds frames (padding > 0)
                // — otherwise that queued audio plays out underrun with no
                // fresh data written behind it, which audibly glitches.
                // SAFETY: silent frames need no data access; the buffer is
                // valid until ReleaseBuffer.
                unsafe {
                    session
                        .render
                        .GetBuffer(allowed as u32)
                        .map_err(|e| com_err("GetBuffer(render)", e))?;
                    session
                        .render
                        .ReleaseBuffer(allowed as u32, AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)
                        .map_err(|e| com_err("ReleaseBuffer(render)", e))?;
                }
            } else {
                // All three gains are applied here, the one place where the
                // app's audio is in our hands: the chunk is in the capture
                // format, which is also what this mirror's render client was
                // initialized with, so the device gets the shape it expects.
                // The program's own level is a property of the source, the
                // device's share is a property of where this copy is going,
                // and the session compensation undoes the session volume the
                // capture has already been through — so they multiply.
                apply_gain(
                    &mut chunk,
                    shared.sample,
                    source_gain(shared)
                        * volume_gain(shared, mirror)
                        * session_compensation(shared),
                );
                let frames = (chunk.len() / shared.block_align) as u32;
                // SAFETY: copy of exactly frames * block_align bytes into the
                // buffer returned by GetBuffer.
                unsafe {
                    let dst = session
                        .render
                        .GetBuffer(frames)
                        .map_err(|e| com_err("GetBuffer(render)", e))?;
                    std::ptr::copy_nonoverlapping(chunk.as_ptr(), dst, chunk.len());
                    session
                        .render
                        .ReleaseBuffer(frames, 0)
                        .map_err(|e| com_err("ReleaseBuffer(render)", e))?;
                }
            }
        }
    }
}

/// Stop a mirror's render client and wait for its source to come back.
///
/// An event-driven render client is signalled once per device period for as
/// long as it is started, whether or not it has anything to play. Writing
/// silence at it forever therefore keeps the endpoint busy and this thread
/// waking about a hundred times a second per mirror, which is what a routed app
/// that is not currently making a sound used to cost. `Stop` takes the client
/// out of the engine's mix, and no further events arrive until it is started
/// again.
///
/// This only ever drops silence. The caller parks once the pipeline is empty
/// and the source has been quiet for `SOURCE_IDLE_MS` plus this mirror's own
/// pipeline depth (see `mirror_quiet`), and a Silent packet is never pushed
/// into a ring to begin with, so nothing audible is discarded; the silence the
/// endpoint still holds makes the stop inaudible as well, and the restart
/// resumes from silence rather than from a click.
fn park_mirror(
    shared: &EngineShared,
    mirror: &MirrorChannel,
    session: &RenderSession,
) -> Result<(), AudioError> {
    // SAFETY: Stop on a started client; errors here are not actionable, the
    // park still holds and the next Start reports the real failure.
    unsafe {
        let _ = session.client.Stop();
    }
    loop {
        // The park is armed before the condition is re-checked, so a packet
        // landing between the caller's check and this call still leaves a token
        // that returns immediately. The timeout is a backstop for a wakeup that
        // never arrives, not the mechanism that ends the wait.
        std::thread::park_timeout(PARK_POLL);
        if shared.shutdown.load(Ordering::Relaxed) {
            return Ok(());
        }
        if mirror.buffered_bytes() > 0 || !source_quiet(shared) {
            break;
        }
    }
    // Rebuilding the pipeline depth is left to the next pass of the caller's
    // loop, which settles the backlog before handing anything to the device.
    // SAFETY: Start on a stopped client.
    if let Err(e) = unsafe { session.client.Start() } {
        return Err(AudioError::Api(format!(
            "Start(render) after idle failed: {e}"
        )));
    }
    Ok(())
}

/// Activate an `IAudioClient` that captures everything `pid` plays.
fn activate_process_loopback(pid: u32) -> Result<IAudioClient, AudioError> {
    let com_owned = crate::audio::init_com()?;
    let result = activate_process_loopback_inner(pid);
    crate::audio::uninit_com(com_owned);
    result
}

fn activate_process_loopback_inner(pid: u32) -> Result<IAudioClient, AudioError> {
    let params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
                TargetProcessId: pid,
            },
        },
    };

    // Wrap the params in a VT_BLOB PROPVARIANT, as the activation API expects.
    // The blob is allocated with CoTaskMemAlloc; the managed PROPVARIANT's
    // Drop runs PropVariantClear, which frees it — so it must NOT be freed
    // manually anywhere in this function.
    let activation_params = unsafe {
        // SAFETY: zeroed PROPVARIANT is a valid empty variant.
        let mut raw: windows::core::imp::PROPVARIANT = core::mem::zeroed();
        // SAFETY: params is a plain-C struct; reading its bytes is valid.
        let bytes = core::slice::from_raw_parts(
            (&params as *const AUDIOCLIENT_ACTIVATION_PARAMS).cast::<u8>(),
            core::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>(),
        );
        // SAFETY: allocation ownership moves into the PROPVARIANT, whose Drop
        // (PropVariantClear) releases it.
        let buf = CoTaskMemAlloc(bytes.len());
        if buf.is_null() {
            return Err(AudioError::Api("CoTaskMemAlloc failed".to_string()));
        }
        // SAFETY: buf holds at least bytes.len() writable bytes.
        core::ptr::copy_nonoverlapping(bytes.as_ptr(), buf.cast::<u8>(), bytes.len());
        // 65 = VT_BLOB; windows-core's imp VARENUM is a plain u16 alias.
        raw.Anonymous.Anonymous.vt = 65u16;
        raw.Anonymous.Anonymous.Anonymous.blob = windows::core::imp::BLOB {
            cbSize: bytes.len() as u32,
            pBlobData: buf.cast::<u8>(),
        };
        // SAFETY: raw is fully initialized above and ownership moves on.
        PROPVARIANT::from_raw(raw)
    };

    let signal = Arc::new(ActivateSignal::default());
    let handler: IActivateAudioInterfaceCompletionHandler = ActivateHandler {
        signal: signal.clone(),
    }
    .into();
    // SAFETY: registered virtual device id, valid IID, blob payload kept alive
    // until after the wait, and handler alive until the callback fires.
    let operation: IActivateAudioInterfaceAsyncOperation = unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&activation_params),
            &handler,
        )
        .map_err(|e| AudioError::Api(format!("ActivateAudioInterfaceAsync failed: {e}")))?
    };

    let (done_lock, notify) = (&signal.done, &signal.notify);
    let done = done_lock.lock().unwrap_or_else(|e| e.into_inner());
    if !*done {
        // Keep the guard alive for the whole wait; it drops with the tuple.
        let (_guard, timeout) = notify
            .wait_timeout_while(done, ACTIVATION_TIMEOUT, |finished| !*finished)
            .unwrap_or_else(|e| e.into_inner());
        if timeout.timed_out() {
            return Err(AudioError::Api(
                "process loopback activation timed out".to_string(),
            ));
        }
    }

    let mut hr = HRESULT(0);
    let mut unk: Option<IUnknown> = None;
    // SAFETY: valid out params on a completed activation operation.
    unsafe {
        operation
            .GetActivateResult(&mut hr, &mut unk)
            .map_err(|e| AudioError::Api(format!("GetActivateResult failed: {e}")))?;
    }
    if hr.is_err() {
        return Err(AudioError::Api(format!(
            "process loopback activation failed: 0x{:08X}",
            hr.0
        )));
    }
    let unk = unk.ok_or_else(|| AudioError::Api("activation returned no interface".to_string()))?;
    unk.cast::<IAudioClient>()
        .map_err(|e| AudioError::Api(format!("activated interface is not IAudioClient: {e}")))
}

/// Completion flag shared between the activation callback and the waiter.
#[derive(Default)]
struct ActivateSignal {
    done: Mutex<bool>,
    notify: Condvar,
}

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct ActivateHandler {
    signal: Arc<ActivateSignal>,
}

// Implemented on the macro-generated wrapper (`Deref`s to `ActivateHandler`),
// which is what the vtable shim requires in windows 0.58.
impl IActivateAudioInterfaceCompletionHandler_Impl for ActivateHandler_Impl {
    fn ActivateCompleted(
        &self,
        _activateoperation: Option<&IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        // The waiter reads the outcome from the operation object itself; the
        // callback only wakes it.
        let mut done = self.signal.done.lock().unwrap_or_else(|e| e.into_inner());
        *done = true;
        self.signal.notify.notify_all();
        Ok(())
    }
}

/// Copy the default render device's mix format.
///
/// Returns `(raw format bytes, bytes per frame, samples per second)`. The
/// engine's shared-mode format is the natural capture format for process
/// loopback, and mirrors let WASAPI auto-convert it to their own mix format.
/// Shared with the calibration tone player, which initializes its render client
/// against the same format so a stream takes the same conversion path no matter
/// who is feeding the device.
pub(crate) fn default_mix_format() -> Result<(Vec<u8>, usize, u32), AudioError> {
    let com_owned = crate::audio::init_com()?;
    let result = (|| -> Result<(Vec<u8>, usize, u32), AudioError> {
        let enumerator: IMMDeviceEnumerator = unsafe {
            // SAFETY: MMDeviceEnumerator is the registered coclass.
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| AudioError::Api(format!("CoCreateInstance failed: {e}")))?
        };
        let device = unsafe {
            // SAFETY: eRender + eConsole are valid flow/role values.
            enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(|e| AudioError::Api(format!("GetDefaultAudioEndpoint failed: {e}")))?
        };
        // SAFETY: activating IAudioClient on an active render device.
        let client: IAudioClient = unsafe {
            device
                .Activate(CLSCTX_ALL, None)
                .map_err(|e| AudioError::Api(format!("Activate(IAudioClient) failed: {e}")))?
        };
        let wfx = unsafe {
            // SAFETY: GetMixFormat returns an owned allocation freed below.
            client
                .GetMixFormat()
                .map_err(|e| AudioError::Api(format!("GetMixFormat failed: {e}")))?
        };
        let (bytes, block_align, sample_rate) = unsafe {
            // SAFETY: wfx is a valid format struct of `total` bytes.
            let fmt = &*wfx;
            let total = core::mem::size_of::<WAVEFORMATEX>() + fmt.cbSize as usize;
            let bytes = core::slice::from_raw_parts(wfx.cast::<u8>(), total).to_vec();
            (bytes, fmt.nBlockAlign as usize, fmt.nSamplesPerSec)
        };
        // SAFETY: balances GetMixFormat's allocation.
        unsafe {
            CoTaskMemFree(Some(wfx.cast::<core::ffi::c_void>()));
        }
        Ok((bytes, block_align, sample_rate))
    })();
    crate::audio::uninit_com(com_owned);
    result
}

/// Reject a mix format whose arithmetic would divide by zero.
///
/// Every trim, top-up and ring bound in this module is a division or modulo by
/// `block_align`, and the pipeline milliseconds are a division by
/// `sample_rate`; a zero from a broken device format would panic on the render
/// thread, which the join now reports but which still leaves that device
/// silent for the life of the route. A rejected start is a failure the caller
/// can see and roll back instead.
fn validate_mix_format(block_align: usize, sample_rate: u32) -> Result<(), AudioError> {
    if block_align == 0 {
        return Err(AudioError::Api(
            "default mix format reports a zero block alignment".to_string(),
        ));
    }
    if sample_rate == 0 {
        return Err(AudioError::Api(
            "default mix format reports a zero sample rate".to_string(),
        ));
    }
    Ok(())
}

/// Creation time as a FILETIME (u64) read from an already-open process handle,
/// or None if the query failed. The caller owns the handle and has already
/// established that the process has not exited.
fn creation_time_of(handle: HANDLE) -> Option<u64> {
    let mut creation = FILETIME::default();
    let mut _exit = FILETIME::default();
    let mut _kernel = FILETIME::default();
    let mut _user = FILETIME::default();
    // SAFETY: valid handle and out params.
    let read =
        unsafe { GetProcessTimes(handle, &mut creation, &mut _exit, &mut _kernel, &mut _user) }
            .is_ok();
    if !read {
        return None;
    }
    Some(((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64)
}

/// Process creation time as a FILETIME (u64), or None if unavailable.
fn process_creation_time(pid: u32) -> Option<u64> {
    // SAFETY: OpenProcess with QUERY_LIMITED_INFORMATION; the handle is closed
    // on both exits below, so a failed query does not leak it.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()? };
    let creation = creation_time_of(handle);
    // SAFETY: balances OpenProcess.
    unsafe {
        let _ = CloseHandle(handle);
    }
    creation
}

/// Returns true while `pid` still refers to the same process that was alive at
/// `recorded_time`. Detects PID reuse by comparing creation times.
fn process_alive(pid: u32, recorded_time: u64) -> bool {
    // SAFETY: OpenProcess with QUERY_LIMITED_INFORMATION; handle closed below.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) };
    match handle {
        Ok(h) => {
            // A terminated-but-still-referenced process opens fine with the
            // query right, so the exit has to be read from the exit code:
            // `WaitForSingleObject` would need `SYNCHRONIZE` on top of
            // `PROCESS_QUERY_LIMITED_INFORMATION`, and the wait it refuses
            // (`WAIT_FAILED`) is indistinguishable from "still running" — which
            // is how an engine outlived its program whenever a launcher, a
            // parent shell or a service kept the last handle open.
            let mut exit_code = 0u32;
            // SAFETY: h is a valid handle, exit_code is a live out parameter.
            let exited = unsafe { GetExitCodeProcess(h, &mut exit_code) }.is_ok()
                && exit_code != STILL_ACTIVE.0 as u32;
            let alive = if exited {
                false
            } else if recorded_time == 0 {
                // No recorded creation time means there is nothing to compare
                // against: reading 0 as a timestamp would call a live process a
                // recycled one on the first idle poll and tear the engine down.
                true
            } else {
                // A different creation time means the PID was recycled. This is
                // read from the handle already open rather than a second
                // OpenProcess: it is the same process object, and this runs on
                // an idle engine's poll, where the extra handle pair would be
                // paid for nothing.
                creation_time_of(h).is_none_or(|current| current == recorded_time)
            };
            // SAFETY: balances OpenProcess.
            unsafe {
                let _ = CloseHandle(h);
            }
            alive
        }
        // The process was openable when the route was applied, so an
        // OpenProcess failure now means it is gone.
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn channel(capacity: usize) -> MirrorChannel {
        MirrorChannel {
            device_id: "test".to_string(),
            ring: Mutex::new(VecDeque::new()),
            capacity,
            delay_ms: AtomicI32::new(0),
            volume_percent: AtomicU32::new(100),
            enabled: AtomicBool::new(true),
            wakeups: AtomicU64::new(0),
            stream_latency_ms: AtomicU32::new(0),
            worker: Mutex::new(None),
        }
    }

    /// Engine shared state with `mirror_delays.len()` mirrors and `primary_ms`
    /// on the natively played device, a 100 ms base latency and a 48 kHz
    /// capture format.
    fn engine(mirror_delays: &[i32], primary_ms: i32, sync: bool) -> EngineShared {
        EngineShared {
            pid: 1,
            exe_name: "test.exe".to_string(),
            generation: 0,
            creation_time: 0,
            shutdown: AtomicBool::new(false),
            mirrors: mirror_delays
                .iter()
                .map(|&delay| {
                    Arc::new(MirrorChannel {
                        device_id: format!("device-{delay}"),
                        ring: Mutex::new(VecDeque::new()),
                        capacity: 1_000_000,
                        delay_ms: AtomicI32::new(delay),
                        volume_percent: AtomicU32::new(100),
                        enabled: AtomicBool::new(true),
                        wakeups: AtomicU64::new(0),
                        stream_latency_ms: AtomicU32::new(0),
                        worker: Mutex::new(None),
                    })
                })
                .collect(),
            capture_worker: Mutex::new(None),
            primary_device_id: "primary".to_string(),
            primary_delay_ms: AtomicI32::new(primary_ms),
            session_volume_percent: AtomicU32::new(100),
            restore_volume_percent: AtomicU32::new(100),
            restore_volume: AtomicBool::new(false),
            volume_claim: Mutex::new(()),
            source_volume_percent: AtomicU32::new(100),
            levels: Arc::new(SourceLevels::new()),
            format: Vec::new(),
            sample: SampleFormat::Unknown,
            block_align: 8,
            sample_rate: 48_000,
            latency_frames: 4_800,
            trim_slack_frames: 960,
            sync_delays: AtomicBool::new(sync),
            go: AtomicBool::new(false),
            ready_count: AtomicUsize::new(0),
            capture_wakeups: AtomicU64::new(0),
            started: Instant::now(),
            last_audio_ms: AtomicU64::new(0),
        }
    }

    #[test]
    fn the_reported_latency_is_our_pipeline_plus_the_endpoints_own() {
        let eng = engine(&[0, 0], 0, true);
        for mirror in &eng.mirrors {
            mirror.stream_latency_ms.store(12, Ordering::Relaxed);
            // 4 800 frames of base latency at 48 kHz is 100 ms, plus the 12 ms
            // the endpoint reports for itself.
            assert_eq!(total_latency_ms(&eng, mirror), Some(112));
        }
    }

    #[test]
    fn a_mirrors_delay_shows_up_in_its_reported_latency() {
        let eng = engine(&[0, 250], 0, true);
        let mirror = &eng.mirrors[1];
        mirror.stream_latency_ms.store(10, Ordering::Relaxed);
        // 100 ms base + 250 ms of compensation + the endpoint's 10 ms.
        assert_eq!(total_latency_ms(&eng, mirror), Some(360));
    }

    #[test]
    fn an_endpoint_that_never_reported_a_latency_has_none_to_show() {
        // Zero is "not measured", not "free": drawing 0 ms would claim the
        // device is playing the app's audio instantly.
        let eng = engine(&[0], 0, true);
        assert_eq!(total_latency_ms(&eng, &eng.mirrors[0]), None);
    }

    #[test]
    fn a_source_that_has_never_played_goes_idle_on_schedule() {
        // `last_audio_ms` starts at zero, so an engine whose app is silent from
        // the moment its route is applied parks on the same schedule as one
        // that fell silent later.
        assert!(!should_park(SOURCE_IDLE_MS - 1, 0));
        assert!(should_park(SOURCE_IDLE_MS, 0));
    }

    #[test]
    fn a_recent_packet_keeps_the_mirrors_playing() {
        assert!(!should_park(10_000, 10_000 - SOURCE_IDLE_MS + 1));
        assert!(should_park(10_000, 10_000 - SOURCE_IDLE_MS));
    }

    #[test]
    fn a_timestamp_ahead_of_now_does_not_read_as_silence() {
        // Saturating subtraction, not wrapping: a stale read must not look like
        // the longest possible silence.
        assert!(!should_park(5, 10));
    }

    #[test]
    fn a_delayed_mirror_parks_only_after_its_own_tail_played_out() {
        // 2 s of compensation puts the pipeline 2.1 s deep, so the source
        // being quiet for the plain idle window is not enough — the device is
        // still playing audio captured before the silence, and the park would
        // cut it.
        let shared = engine(&[2_000], 0, true);
        let mirror = &shared.mirrors[0];
        assert_eq!(mirror_pipeline_ms(&shared, mirror), 2_100);
        let last_audio = 0;
        assert!(!should_park(
            SOURCE_IDLE_MS + 2_000,
            last_audio + mirror_pipeline_ms(&shared, mirror)
        ));
        assert!(should_park(
            SOURCE_IDLE_MS + 2_100,
            last_audio + mirror_pipeline_ms(&shared, mirror)
        ));
        // A base-latency mirror parks on (approximately) the plain window.
        let plain = engine(&[0], 0, true);
        assert_eq!(mirror_pipeline_ms(&plain, &plain.mirrors[0]), 100);
    }

    #[test]
    fn push_and_pop_stay_frame_aligned() {
        let ch = channel(100_000);
        let frame = 8usize;
        let mut out = Vec::new();
        ch.push(&vec![0u8; 100 * frame], frame);
        assert_eq!(ch.buffered_bytes(), 100 * frame);
        ch.pop(30, frame, &mut out);
        assert_eq!(out.len(), 30 * frame);
        // Asking for more than buffered returns exactly what is left.
        ch.pop(999, frame, &mut out);
        assert_eq!(out.len(), 70 * frame);
    }

    #[test]
    fn push_caps_ring_in_whole_frames() {
        let ch = channel(1000);
        let frame = 8usize;
        ch.push(&vec![0u8; 200 * frame], frame);
        // 1600 bytes pushed, capped at 1000 — itself a multiple of 8.
        assert_eq!(ch.buffered_bytes(), 1000);
    }

    #[test]
    fn drop_oldest_keeps_newest_frames() {
        let ch = channel(100_000);
        let frame = 8usize;
        let mut data = vec![0u8; 10 * frame];
        for (i, slot) in data.chunks_mut(frame).enumerate() {
            slot[0] = i as u8;
        }
        ch.push(&data, frame);
        ch.drop_oldest(4, frame);
        let mut out = Vec::new();
        ch.pop(999, frame, &mut out);
        assert_eq!(out.len(), 6 * frame);
        assert_eq!(out[0], 4);
        assert_eq!(out[out.len() - frame], 9);
    }

    #[test]
    fn prepend_silence_inserts_zeros_at_front() {
        let ch = channel(100_000);
        let frame = 8usize;
        let mut data = vec![0u8; 10 * frame];
        for (i, slot) in data.chunks_mut(frame).enumerate() {
            slot[0] = (i + 1) as u8;
        }
        ch.push(&data, frame);
        ch.prepend_silence(4, frame);
        let mut out = Vec::new();
        ch.pop(999, frame, &mut out);
        assert_eq!(out.len(), 14 * frame);
        assert!(out[..4 * frame].iter().all(|&b| b == 0));
        // The original data follows the silence, in order.
        assert_eq!(out[4 * frame], 1);
        assert_eq!(out[out.len() - frame], 10);
    }

    #[test]
    fn prepend_silence_respects_capacity() {
        let ch = channel(40 * 8);
        let frame = 8usize;
        ch.push(&vec![1u8; 30 * frame], frame);
        // Only 10 frames of headroom remain; the request is clamped to it.
        ch.prepend_silence(100, frame);
        assert_eq!(ch.buffered_bytes(), 40 * frame);
        let mut out = Vec::new();
        ch.pop(999, frame, &mut out);
        assert!(out[..10 * frame].iter().all(|&b| b == 0));
        assert_eq!(out[10 * frame], 1);
    }

    #[test]
    fn prepend_silence_on_disabled_mirror_is_noop() {
        let ch = channel(100_000);
        ch.enabled.store(false, Ordering::Relaxed);
        ch.prepend_silence(10, 8);
        assert_eq!(ch.buffered_bytes(), 0);
    }

    #[test]
    fn disabled_mirror_is_passive() {
        let ch = channel(100_000);
        ch.enabled.store(false, Ordering::Relaxed);
        ch.push(&[0u8; 80], 8);
        assert_eq!(ch.buffered_bytes(), 0);
        let mut out = Vec::new();
        ch.pop(10, 8, &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn a_delay_is_measured_against_the_app_audio() {
        // The primary plays natively at 0 ms; a mirror set to 1 s is held back
        // by exactly that second.
        let shared = engine(&[1_000], 0, true);
        assert_eq!(target_frames(&shared, &shared.mirrors[0]), 4_800 + 48_000);
    }

    #[test]
    fn the_earliest_device_of_the_group_is_the_reference() {
        // Wired set to 0 ms, Bluetooth set to 200 ms: the wired one stays at the
        // base latency and the Bluetooth copy is held back by 200 ms.
        let shared = engine(&[0, 200], 0, true);
        assert_eq!(group_min_delay_ms(&shared), 0);
        assert_eq!(target_frames(&shared, &shared.mirrors[0]), 4_800);
        assert_eq!(target_frames(&shared, &shared.mirrors[1]), 4_800 + 9_600);
    }

    #[test]
    fn every_device_carries_its_own_absolute_delay() {
        // Three devices at 0 / 50 / 250 ms keep their exact 50 ms and 250 ms
        // spreads, whatever order the route was built in.
        let shared = engine(&[50, 250], 0, true);
        assert_eq!(target_frames(&shared, &shared.mirrors[0]), 4_800 + 2_400);
        assert_eq!(target_frames(&shared, &shared.mirrors[1]), 4_800 + 12_000);
    }

    #[test]
    fn the_primary_delay_of_the_group_lifts_every_mirror() {
        // The primary is set to 300 ms: it cannot be delayed itself, so the
        // whole group is aligned relative to it and the mirrors sit 300 ms and
        // 500 ms above the earliest device, i.e. 0 ms and 200 ms apart.
        let shared = engine(&[300, 500], 300, true);
        assert_eq!(group_min_delay_ms(&shared), 300);
        assert_eq!(target_frames(&shared, &shared.mirrors[0]), 4_800);
        assert_eq!(target_frames(&shared, &shared.mirrors[1]), 4_800 + 9_600);
    }

    #[test]
    fn a_delay_below_the_reference_keeps_the_mirror_at_the_base_latency() {
        // A value under the group minimum would require *negative* software
        // delay; the mirror simply stays at the base latency instead.
        let shared = engine(&[-500], -200, true);
        assert_eq!(group_min_delay_ms(&shared), -500);
        assert_eq!(target_frames(&shared, &shared.mirrors[0]), 4_800);
    }

    #[test]
    fn disabled_mirrors_do_not_move_the_reference() {
        let shared = engine(&[-1_000, 0], 0, true);
        shared.mirrors[0].enabled.store(false, Ordering::Relaxed);
        assert_eq!(group_min_delay_ms(&shared), 0);
        assert_eq!(target_frames(&shared, &shared.mirrors[1]), 4_800);
    }

    #[test]
    fn delays_are_ignored_while_delay_sync_is_off() {
        let shared = engine(&[2_000, -3_000], 1_000, false);
        for mirror in &shared.mirrors {
            assert_eq!(target_frames(&shared, mirror), 4_800);
        }
    }

    /// Engine whose mirrors carry the given volumes, with the program's
    /// session volume at `session_percent`.
    fn engine_with_volumes(mirror_percents: &[u32], session_percent: u32) -> EngineShared {
        let shared = engine(&vec![0; mirror_percents.len()], 0, true);
        for (mirror, percent) in shared.mirrors.iter().zip(mirror_percents) {
            mirror.volume_percent.store(*percent, Ordering::Relaxed);
        }
        shared
            .session_volume_percent
            .store(session_percent, Ordering::Relaxed);
        shared
    }

    #[test]
    fn the_loudest_copy_is_the_reference_volume() {
        let shared = engine_with_volumes(&[50, 100], 80);
        assert_eq!(group_max_volume(&shared), 100);
        // The loudest copy plays as the app produced it; the quieter one is
        // brought down to half.
        assert_eq!(volume_gain(&shared, &shared.mirrors[0]), 0.5);
        assert_eq!(volume_gain(&shared, &shared.mirrors[1]), 1.0);
    }

    #[test]
    fn the_session_volume_is_not_in_the_copies_reference() {
        // The primary's loudness is the program's session volume — a property
        // of the program, not of a device — so it stays out of the reference
        // the mirrors are measured against. A session-volume change must not
        // move a single mirror's share gain.
        let shared = engine_with_volumes(&[25, 50], 100);
        assert_eq!(group_max_volume(&shared), 50);
        assert_eq!(volume_gain(&shared, &shared.mirrors[0]), 0.5);
        assert_eq!(volume_gain(&shared, &shared.mirrors[1]), 1.0);
    }

    #[test]
    fn the_copies_are_compensated_for_the_session_volume() {
        // The capture sits behind the session volume, so a mirror's total gain
        // divides it back out: at a session volume of 50 the captured stream
        // is half of what the program produced, and the copies play at exactly
        // the share the device asked for — 100 here, i.e. untouched.
        let shared = engine_with_volumes(&[100], 50);
        let mirror = &shared.mirrors[0];
        assert_eq!(session_compensation(&shared), 2.0);
        assert_eq!(
            source_gain(&shared) * volume_gain(&shared, mirror) * session_compensation(&shared),
            2.0
        );

        // And the floor keeps an out-of-band zero from dividing.
        shared.session_volume_percent.store(0, Ordering::Relaxed);
        assert_eq!(
            source_gain(&shared) * volume_gain(&shared, mirror) * session_compensation(&shared),
            20.0
        );
    }

    #[test]
    fn an_all_muted_group_stays_silent_instead_of_dividing_by_zero() {
        let shared = engine_with_volumes(&[0, 0], 0);
        assert_eq!(group_max_volume(&shared), 1);
        assert_eq!(volume_gain(&shared, &shared.mirrors[0]), 0.0);
    }

    #[test]
    fn disabled_mirrors_do_not_raise_the_copies_reference_volume() {
        let shared = engine_with_volumes(&[20, 100], 50);
        shared.mirrors[1].enabled.store(false, Ordering::Relaxed);
        assert_eq!(group_max_volume(&shared), 20);
        assert_eq!(volume_gain(&shared, &shared.mirrors[0]), 1.0);
    }

    #[test]
    fn a_share_above_the_reference_never_boosts() {
        // The mirror's own share and the group max are two separate reads, and
        // a volume change — or a mirror going out of service — between them
        // can hand back a max below `own`. Attenuation is the only thing this
        // gain may do, so the read floors at the mirror's own share rather
        // than letting one chunk through at a boost.
        let shared = engine_with_volumes(&[100, 20], 80);
        shared.mirrors[0].enabled.store(false, Ordering::Relaxed);
        // The loudest share is no longer counted in the reference...
        assert_eq!(group_max_volume(&shared), 20);
        // ...but its own gain still never boosts.
        assert_eq!(volume_gain(&shared, &shared.mirrors[0]), 1.0);
    }

    #[test]
    fn gain_scales_float32_samples_in_place() {
        let mut bytes: Vec<u8> = [1.0f32, -0.5, 0.0, 0.25]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        apply_gain(&mut bytes, SampleFormat::Float32, 0.5);
        let scaled: Vec<f32> = bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|c| f32::from_le_bytes(*c))
            .collect();
        assert_eq!(scaled, vec![0.5, -0.25, 0.0, 0.125]);
    }

    #[test]
    fn gain_scales_16_bit_pcm_samples() {
        let mut bytes: Vec<u8> = [i16::MIN, -1000, 1000, i16::MAX]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        apply_gain(&mut bytes, SampleFormat::Int(2), 0.5);
        let scaled: Vec<i16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| i16::from_le_bytes(*c))
            .collect();
        // Halving an odd value rounds away from zero, so the top ends at 16384
        // rather than 16383 — the error is one LSB of the quantisation step.
        assert_eq!(scaled, vec![-16384, -500, 500, 16384]);
    }

    #[test]
    fn gain_above_unity_amplifies_instead_of_being_skipped() {
        let mut bytes: Vec<u8> = [0.25f32, -0.5]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        apply_gain(&mut bytes, SampleFormat::Float32, 2.0);
        let scaled: Vec<f32> = bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|c| f32::from_le_bytes(*c))
            .collect();
        assert_eq!(scaled, vec![0.5, -1.0]);
    }

    #[test]
    fn an_amplified_integer_sample_saturates_at_full_scale() {
        let mut bytes: Vec<u8> = [i16::MAX, 1000]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        apply_gain(&mut bytes, SampleFormat::Int(2), 4.0);
        let scaled: Vec<i16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| i16::from_le_bytes(*c))
            .collect();
        // An integer format cannot hold more than full scale, so an
        // amplification that overshoots is clamped rather than wrapped around.
        assert_eq!(scaled, vec![i16::MAX, 4000]);
    }

    #[test]
    fn unity_gain_is_still_the_only_gain_that_skips_the_buffer() {
        let mut bytes = vec![1u8, 2, 3, 4];
        let before = bytes.clone();
        apply_gain(&mut bytes, SampleFormat::Float32, 1.0);
        assert_eq!(bytes, before);
    }

    #[test]
    fn a_chunk_is_measured_as_a_fraction_of_full_scale() {
        // Two float samples, 0.5 and -1.0: mean square 0.625, peak 1.0.
        let bytes: Vec<u8> = [0.5f32, -1.0]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        let (mean_sq, peak) = measure_chunk(&bytes, SampleFormat::Float32).unwrap();
        assert!((mean_sq - 0.625).abs() < 1e-6, "mean square was {mean_sq}");
        assert_eq!(peak, 1.0);
    }

    #[test]
    fn an_integer_chunk_is_measured_against_its_own_full_scale() {
        let bytes: Vec<u8> = [i16::MIN + 1, i16::MAX]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        let (_, peak) = measure_chunk(&bytes, SampleFormat::Int(2)).unwrap();
        // Both ends of a 16-bit sample sit at full scale, so the level of a
        // quiet program and a loud one are comparable across formats.
        assert!((peak - 1.0).abs() < 1e-4, "peak was {peak}");
    }

    #[test]
    fn a_format_that_cannot_be_read_has_no_level_at_all() {
        // Not silence: a program whose samples cannot be read has to stay out of
        // the estimate, or an alignment would treat it as quiet and amplify it.
        assert_eq!(measure_chunk(&[7u8; 16], SampleFormat::Unknown), None);
    }

    #[test]
    fn the_first_chunk_seeds_the_level_instead_of_fading_up() {
        let mut tracker = LevelTracker::default();
        tracker.fold(0.25, 0.5, 10.0);
        assert!(
            (tracker.rms() - 0.5).abs() < 1e-6,
            "level was {}",
            tracker.rms()
        );
        assert_eq!(tracker.peak, 0.5);
    }

    #[test]
    fn an_engine_that_lost_every_copy_says_copies_failed_not_playing() {
        // The hold decision and the honest `active_routes` reading both key on
        // this: pushes are no-ops for a failed mirror, so once none is enabled
        // the loopback client has no consumer and must be released. One copy
        // left standing, though, keeps the engine pumping normally.
        let shared = engine(&[0, 0], 0, true);
        assert!(!shared.all_mirrors_lost());
        shared.mirrors[0].enabled.store(false, Ordering::Relaxed);
        assert!(!shared.all_mirrors_lost());
        shared.mirrors[1].enabled.store(false, Ordering::Relaxed);
        assert!(shared.all_mirrors_lost());
    }

    #[test]
    fn a_stop_that_lands_while_a_start_is_in_flight_waits_for_it() {
        // The resurrection bug: `stop` removed nothing while a start walked its
        // slow COM path, and the start's later insertion brought back an engine
        // whose route was already gone. The registry is what closes that window
        // — a waiter must not pass until the start has settled.
        let registry = Arc::new(StartRegistry::default());
        registry.begin(7);
        registry.begin(7); // two overlapping starts: one clear is not enough
        let (tx, rx) = std::sync::mpsc::channel();
        let waiting = {
            let registry = Arc::clone(&registry);
            std::thread::spawn(move || {
                registry.wait_for_quiet(7);
                let _ = tx.send(());
            })
        };
        assert!(
            rx.recv_timeout(Duration::from_millis(200)).is_err(),
            "the stop passed while a start was still in flight"
        );
        registry.clear(7);
        assert!(
            rx.recv_timeout(Duration::from_millis(200)).is_err(),
            "the stop passed while the second start was still in flight"
        );
        registry.clear(7);
        assert!(
            rx.recv_timeout(Duration::from_secs(1)).is_ok(),
            "the stop never woke when both starts had settled"
        );
        waiting.join().unwrap();
    }

    #[test]
    fn a_lost_copies_hold_ends_the_moment_a_stop_lands() {
        // The hold's named wake source, exercised for real: the thread is
        // parked, a stop sets the flag and unparks it, and the hold answers
        // with `Stopped` — not by sitting out the backstop. The fixture's pid
        // is this test process, which stays alive for the whole wait, so the
        // only way out is the stop.
        let mut shared = engine(&[0], 0, true);
        shared.pid = std::process::id();
        let shared = Arc::new(shared);
        let holding = {
            let shared = Arc::clone(&shared);
            std::thread::spawn(move || {
                matches!(hold_after_lost_copies(&shared), ExitReason::Stopped)
            })
        };
        loop {
            if shared
                .capture_worker
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_some()
            {
                break;
            }
            std::thread::yield_now();
        }
        shared.shutdown.store(true, Ordering::Relaxed);
        wake_capture(&shared);
        assert!(
            holding
                .join()
                .expect("the hold thread died instead of ending"),
            "the hold ended for a reason other than the stop"
        );
    }

    #[test]
    fn a_zero_block_align_or_sample_rate_never_reaches_the_ring_arithmetic() {
        // Trims, top-ups and ring bounds all divide by one of the two; a zero
        // panics on the render thread, so the format is refused at the start.
        assert!(validate_mix_format(8, 48_000).is_ok());
        assert!(validate_mix_format(0, 48_000).is_err());
        assert!(validate_mix_format(8, 0).is_err());
    }

    #[test]
    fn a_short_chunk_moves_the_level_only_a_little() {
        let mut tracker = LevelTracker::default();
        tracker.fold(0.0, 0.0, 10.0);
        // A tenth of the window, so a tenth of the way to the new level.
        tracker.fold(1.0, 1.0, LEVEL_WINDOW_MS / 10.0);
        assert!(
            (tracker.rms() - 0.316).abs() < 0.01,
            "level was {}",
            tracker.rms()
        );
    }

    #[test]
    fn a_loud_moment_fades_out_over_the_release_time() {
        let mut tracker = LevelTracker::default();
        tracker.fold(0.01, 1.0, 10.0);
        assert_eq!(tracker.peak, 1.0);

        // Delivered packet by packet, the way the capture does.
        let chunk_ms = 10.0;
        for _ in 0..(PEAK_RELEASE_MS / chunk_ms) as usize {
            tracker.fold(0.01, 0.0, chunk_ms);
        }
        assert!(tracker.peak < 0.4, "peak was {}", tracker.peak);

        // A new loud moment takes over immediately, whatever the decay has done.
        tracker.fold(0.01, 0.9, chunk_ms);
        assert_eq!(tracker.peak, 0.9);
    }

    #[test]
    fn a_level_is_published_as_the_program_produced_it() {
        // The tap sits behind the session volume and the mirrors put that
        // factor straight back: an estimate left in tap units would rank two
        // programmes an exact session-ratio apart, and the alignment would
        // write gains wrong by that ratio on every copied device.
        let mut eng = engine(&[0], 0, true);
        eng.sample = SampleFormat::Float32;
        eng.session_volume_percent.store(50, Ordering::Relaxed);

        // Four samples at 0.5: mean square 0.25, peak 0.5 at the tap.
        let bytes: Vec<u8> = [0.5f32; 4].iter().flat_map(|v| v.to_le_bytes()).collect();
        let mut level = LevelTracker::default();
        measure_into(&mut level, &eng, &bytes, 4);

        // Halved at the tap, so what the program produced is twice as loud.
        assert!(
            (level.rms() - 1.0).abs() < 1e-6,
            "level was {}",
            level.rms()
        );
        assert!((level.peak - 1.0).abs() < 1e-6, "peak was {}", level.peak);
    }

    #[test]
    fn a_programs_own_level_can_amplify_it() {
        // One mirror, both volumes neutral, so the device share is exactly 1.0
        // and the product below is the program's level alone.
        let eng = engine(&[0], 0, true);
        let mirror = &eng.mirrors[0];
        assert_eq!(source_gain(&eng) * volume_gain(&eng, mirror), 1.0);

        // A program quieter than its neighbours is brought up to them, and what
        // `apply_gain` is handed is then above unity — which is the only reason
        // the shortcut there may not test `>=`.
        eng.source_volume_percent.store(250, Ordering::Relaxed);
        assert_eq!(source_gain(&eng), 2.5);
        assert_eq!(source_gain(&eng) * volume_gain(&eng, mirror), 2.5);
    }

    #[test]
    fn gain_leaves_the_audio_alone_when_it_cannot_be_read() {
        let mut bytes = vec![7u8, 7, 7, 7];
        let before = bytes.clone();
        apply_gain(&mut bytes, SampleFormat::Unknown, 0.5);
        assert_eq!(bytes, before);
    }

    #[test]
    fn an_extensible_float_format_is_recognized() {
        // 40 bytes: WAVEFORMATEX with cbSize=22 followed by the extensible
        // tail, whose SubFormat starts at offset 24.
        let mut format = vec![0u8; 40];
        format[0..2].copy_from_slice(&0xFFFEu16.to_le_bytes());
        format[14..16].copy_from_slice(&32u16.to_le_bytes());
        format[16..18].copy_from_slice(&22u16.to_le_bytes());
        format[24..28].copy_from_slice(&[0x03, 0x00, 0x00, 0x00]);
        assert_eq!(SampleFormat::parse(&format), SampleFormat::Float32);

        format[24..28].copy_from_slice(&[0x01, 0x00, 0x00, 0x00]);
        assert_eq!(SampleFormat::parse(&format), SampleFormat::Int(4));
    }
}
