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
use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
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
    CreateEventW, GetProcessTimes, OpenProcess, WaitForSingleObject,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::audio::levels::SourceLevels;
use crate::audio::AudioError;
use crate::config::{DelayConfig, SourceVolumeConfig, VolumeConfig, DELAY_RANGE_MAX_MS};

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
}

impl ExitReason {
    fn event_name(&self) -> &'static str {
        match self {
            ExitReason::Stopped => "stopped",
            ExitReason::ProcessExited => "process-exited",
            ExitReason::Error(_) => "error",
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

    /// Take at most `max_frames` frames of audio for one render cycle.
    fn pop(&self, max_frames: usize, block_align: usize) -> Vec<u8> {
        if max_frames == 0 || !self.enabled.load(Ordering::Relaxed) {
            return Vec::new();
        }
        let mut ring = self.ring.lock().unwrap_or_else(|e| e.into_inner());
        let take = ring.len().min(max_frames * block_align);
        let aligned = take - take % block_align;
        ring.drain(..aligned).collect()
    }
}

/// Immutable state shared by one engine's threads.
struct EngineShared {
    pid: u32,
    /// Executable this engine duplicates. The per-program level is keyed by it
    /// rather than by `pid`, because one program can hold several sessions.
    exe_name: String,
    generation: u64,
    /// Process creation time as a FILETIME (u64), used to detect PID reuse.
    creation_time: u64,
    shutdown: AtomicBool,
    mirrors: Vec<Arc<MirrorChannel>>,
    /// Device the OS plays natively, i.e. the one endpoint this engine cannot
    /// hold back in software. Only used to route delay updates to
    /// `primary_delay_ms`.
    primary_device_id: String,
    /// The primary device's configured delay. It cannot be applied, but it is
    /// the reference the mirrors are measured against (see
    /// `group_min_delay_ms`), so a change has to reach live engines.
    primary_delay_ms: AtomicI32,
    /// The primary device's configured volume. The OS plays that endpoint
    /// natively, so the value cannot be applied to it — but it still counts
    /// towards the group's reference level (see `group_max_volume`), which is
    /// what every mirror is scaled against.
    primary_volume_percent: AtomicU32,
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

/// Per-process duplication engines, managed as Tauri state.
pub struct DuplicationManager {
    engines: Mutex<HashMap<u32, Arc<EngineShared>>>,
    /// Persisted per-device delay compensation values.
    delays: Arc<DelayConfig>,
    /// Persisted per-device volume values.
    volumes: Arc<VolumeConfig>,
    /// Persisted per-program level values.
    sources: Arc<SourceVolumeConfig>,
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
        levels: Arc<SourceLevels>,
    ) -> Self {
        Self {
            engines: Mutex::new(HashMap::new()),
            delays,
            volumes,
            sources,
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

    /// Push a new volume value to any live engine using `device_id`, mirror or
    /// primary. Persisting the value is the caller's job (see `VolumeConfig`).
    pub fn update_volume(&self, device_id: &str, percent: u32) {
        for engine in self
            .engines
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            if engine.primary_device_id == device_id {
                engine
                    .primary_volume_percent
                    .store(percent, Ordering::Relaxed);
            }
            for mirror in &engine.mirrors {
                if mirror.device_id == device_id {
                    mirror.volume_percent.store(percent, Ordering::Relaxed);
                }
            }
        }
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

    /// Re-read every device's persisted delay. Needed after the configured
    /// range changed, which may have clamped values that live engines are still
    /// applying.
    pub fn reload_delays(&self) {
        for engine in self
            .engines
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            engine.primary_delay_ms.store(
                self.delays.get(&engine.primary_device_id),
                Ordering::Relaxed,
            );
            for mirror in &engine.mirrors {
                mirror
                    .delay_ms
                    .store(self.delays.get(&mirror.device_id), Ordering::Relaxed);
            }
        }
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
    pub fn start(
        &self,
        pid: u32,
        exe_name: &str,
        primary_device_id: &str,
        mirror_device_ids: Vec<String>,
        app: &AppHandle,
    ) -> Result<u64, AudioError> {
        self.stop(pid);
        if mirror_device_ids.is_empty() {
            return Ok(0);
        }
        if pid == 0 {
            return Err(AudioError::Api("invalid pid".to_string()));
        }

        let (format, block_align, sample_rate) = default_mix_format()?;
        let sample = SampleFormat::parse(&format);
        // Ring must hold the worst case pipeline a configuration can ask for:
        // the base latency plus the largest spread between the earliest and the
        // latest device, which two opposite extremes of the range can produce.
        let ring_capacity = sample_rate as usize
            * (LATENCY_TARGET_MS + 2 * DELAY_RANGE_MAX_MS as usize + TRIM_SLACK_MS + 100)
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
            primary_device_id: primary_device_id.to_string(),
            primary_delay_ms: AtomicI32::new(self.delays.get(primary_device_id)),
            primary_volume_percent: AtomicU32::new(self.volumes.get(primary_device_id)),
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
        self.engines
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(pid, shared.clone());

        let generation = shared.generation;
        let app = app.clone();
        if let Err(e) = std::thread::Builder::new()
            .name(format!("aar-dup-{pid}"))
            .spawn(move || capture_main(shared, app))
        {
            // The engine never started, so no thread will unregister it; drop
            // the entry here or `active_routes` would report it forever.
            self.unregister(pid, generation);
            return Err(AudioError::Api(format!("spawn capture thread failed: {e}")));
        }
        Ok(generation)
    }

    /// Signal the engine for `pid` to stop. Threads clean up asynchronously.
    pub fn stop(&self, pid: u32) {
        let engine = self
            .engines
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&pid);
        if let Some(shared) = engine {
            shared.shutdown.store(true, Ordering::Relaxed);
            // A mirror parked on a quiet source waits on its own thread rather
            // than on the device, so it has to be woken or the capture thread
            // cannot join it until the park's backstop expires.
            for mirror in &shared.mirrors {
                mirror.wake();
            }
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
    /// engine's own capture thread on exit.
    fn unregister(&self, pid: u32, generation: u64) {
        let mut engines = self.engines.lock().unwrap_or_else(|e| e.into_inner());
        if engines.get(&pid).map(|e| e.generation) == Some(generation) {
            engines.remove(&pid);
        }
    }
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
    app.state::<DuplicationManager>()
        .unregister(shared.pid, shared.generation);
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

    let mut render_threads = Vec::with_capacity(shared.mirrors.len());
    for mirror in &shared.mirrors {
        let mirror = mirror.clone();
        let shared = shared.clone();
        let app = app.clone();
        // Render threads report their own errors via `enabled`, so the join
        // result is ignored on purpose.
        render_threads.push(std::thread::spawn(move || render_main(shared, mirror, app)));
    }

    let mut gate = StartGate {
        opened_at: Instant::now(),
        opened: false,
    };
    let reason = capture_packets(shared, &capture, event, &mut gate);
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
    for handle in render_threads {
        let _ = handle.join();
    }
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

/// Volume of the group's loudest device, which is the level every other device
/// is scaled against.
///
/// This is the volume counterpart of the delay reference: the engine only
/// writes mirrors, and software gain attenuates but never boosts, so the
/// loudest device of the group stays exactly where the app put it and the rest
/// are brought down towards it. The primary counts towards the reference even
/// though its own value cannot be applied. Mirrors that failed to open are
/// ignored, exactly as they are for delays. Floored at 1 so an all-zero group
/// stays a valid (silent) division.
fn group_max_volume(shared: &EngineShared) -> u32 {
    shared
        .mirrors
        .iter()
        .filter(|m| m.enabled.load(Ordering::Relaxed))
        .map(|m| m.volume_percent.load(Ordering::Relaxed))
        .chain(std::iter::once(
            shared.primary_volume_percent.load(Ordering::Relaxed),
        ))
        .max()
        .unwrap_or(100)
        .max(1)
}

/// Gain to apply to `mirror`'s frames: its own share of the group's loudest
/// device, i.e. 1.0 when it is the loudest one (or the only one left).
fn volume_gain(shared: &EngineShared, mirror: &MirrorChannel) -> f32 {
    mirror.volume_percent.load(Ordering::Relaxed) as f32 / group_max_volume(shared) as f32
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
                // Measured before the push and outside the ring, so the level
                // describes what the program produced rather than what any one
                // device was handed after its own gains.
                if let Some((mean_sq, peak)) = measure_chunk(chunk, shared.sample) {
                    let chunk_ms = frames as f32 * 1000.0 / shared.sample_rate.max(1) as f32;
                    level.fold(mean_sq, peak, chunk_ms);
                    level.publish_if_due(&shared.levels, &shared.exe_name, shared.pid);
                }
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
        if mirror.buffered_bytes() == 0 && source_quiet(shared) {
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
            let mut chunk = mirror.pop(allowed, shared.block_align);
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
                // Both gains are applied here, the one place where the app's
                // audio is in our hands: the chunk is in the capture format,
                // which is also what this mirror's render client was initialized
                // with, so the device gets the shape it expects. The program's
                // own level is a property of the source and the device's share
                // is a property of where this copy is going, so they multiply.
                apply_gain(
                    &mut chunk,
                    shared.sample,
                    source_gain(shared) * volume_gain(shared, mirror),
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
/// and the source has been quiet for `SOURCE_IDLE_MS`, and a Silent packet is
/// never pushed into a ring to begin with, so nothing audible is discarded; the
/// silence the endpoint still holds makes the stop inaudible as well, and the
/// restart resumes from silence rather than from a click.
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
fn default_mix_format() -> Result<(Vec<u8>, usize, u32), AudioError> {
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
            // SAFETY: h is a valid handle; WAIT_OBJECT_0 means terminated.
            let exited = unsafe { WaitForSingleObject(h, 0) } == WAIT_OBJECT_0;
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
            primary_device_id: "primary".to_string(),
            primary_delay_ms: AtomicI32::new(primary_ms),
            primary_volume_percent: AtomicU32::new(100),
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
    fn push_and_pop_stay_frame_aligned() {
        let ch = channel(100_000);
        let frame = 8usize;
        ch.push(&vec![0u8; 100 * frame], frame);
        assert_eq!(ch.buffered_bytes(), 100 * frame);
        assert_eq!(ch.pop(30, frame).len(), 30 * frame);
        // Asking for more than buffered returns exactly what is left.
        assert_eq!(ch.pop(999, frame).len(), 70 * frame);
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
        let out = ch.pop(999, frame);
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
        let out = ch.pop(999, frame);
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
        let out = ch.pop(999, frame);
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
        assert!(ch.pop(10, 8).is_empty());
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

    /// Engine whose mirrors carry the given volumes, with the primary at
    /// `primary_percent`.
    fn engine_with_volumes(mirror_percents: &[u32], primary_percent: u32) -> EngineShared {
        let shared = engine(&vec![0; mirror_percents.len()], 0, true);
        for (mirror, percent) in shared.mirrors.iter().zip(mirror_percents) {
            mirror.volume_percent.store(*percent, Ordering::Relaxed);
        }
        shared
            .primary_volume_percent
            .store(primary_percent, Ordering::Relaxed);
        shared
    }

    #[test]
    fn the_loudest_device_is_the_reference_volume() {
        let shared = engine_with_volumes(&[50, 100], 80);
        assert_eq!(group_max_volume(&shared), 100);
        // The loudest device plays as the app produced it; the quieter one is
        // brought down to half.
        assert_eq!(volume_gain(&shared, &shared.mirrors[0]), 0.5);
        assert_eq!(volume_gain(&shared, &shared.mirrors[1]), 1.0);
    }

    #[test]
    fn the_primary_counts_towards_the_reference_volume() {
        // The primary is the loudest, so every mirror is measured against it
        // even though its own value cannot be applied to the audio.
        let shared = engine_with_volumes(&[25, 50], 100);
        assert_eq!(group_max_volume(&shared), 100);
        assert_eq!(volume_gain(&shared, &shared.mirrors[0]), 0.25);
        assert_eq!(volume_gain(&shared, &shared.mirrors[1]), 0.5);
    }

    #[test]
    fn an_all_muted_group_stays_silent_instead_of_dividing_by_zero() {
        let shared = engine_with_volumes(&[0, 0], 0);
        assert_eq!(group_max_volume(&shared), 1);
        assert_eq!(volume_gain(&shared, &shared.mirrors[0]), 0.0);
    }

    #[test]
    fn disabled_mirrors_do_not_raise_the_reference_volume() {
        let shared = engine_with_volumes(&[20, 100], 50);
        shared.mirrors[1].enabled.store(false, Ordering::Relaxed);
        assert_eq!(group_max_volume(&shared), 50);
        assert_eq!(volume_gain(&shared, &shared.mirrors[0]), 0.4);
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
        format[18..20].copy_from_slice(&22u16.to_le_bytes());
        format[24..28].copy_from_slice(&[0x03, 0x00, 0x00, 0x00]);
        assert_eq!(SampleFormat::parse(&format), SampleFormat::Float32);

        format[24..28].copy_from_slice(&[0x01, 0x00, 0x00, 0x00]);
        assert_eq!(SampleFormat::parse(&format), SampleFormat::Int(4));
    }
}
