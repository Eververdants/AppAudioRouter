//!
//! The measurement side of the delay-calibration wizard: play a few short tone
//! bursts on one device and let the user time them with a held button.
//!
//! The backend's job is only to make the bursts predictable and to mark them.
//! Each burst is bracketed by two `calibration-tone` events — `start` when the
//! first tone frame is written into the endpoint, `end` when the last one is —
//! and the frontend timestamps those arrivals and the user's press/release
//! against its own clock. The *offset* between the two midpoints is what a
//! device's inherent latency (endpoint pipeline plus whatever the hardware, a
//! Bluetooth codec above all, adds) contributes to; everything the two
//! measurements share — the human reaction time, the write-ahead padding this
//! player keeps, the event delivery — is common to every device and cancels
//! when one device's offset is subtracted from another's. That difference is
//! the whole product: the wizard writes compensation values, never absolutes.
//!
//! Playback is the same shape as a mirror's render loop (event-driven shared
//! client, buffer topped up towards a fixed padding target) so the conversion
//! path and the pacing jitter a burst experiences match what a real copy would.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::json;
use tauri::{AppHandle, Emitter};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Media::Audio::{
    IAudioClient, IAudioRenderClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, WAVEFORMATEX,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

use super::duplication::default_mix_format;
use super::AudioError;

/// How long one burst sounds, in milliseconds. Long enough to press and hold
/// comfortably, short enough that three of them with pauses stay quick.
pub const TONE_BURST_MS: usize = 800;
/// Bursts per device. Three presses average out the reaction jitter; the
/// frontend discards a press whose hold duration does not match the burst.
pub const TONE_REPS: usize = 3;
/// Pitch of the burst: comfortably audible on every consumer device.
const TONE_HZ: f32 = 880.0;
/// Peak amplitude of the burst: clearly audible without startle, and quiet
/// enough that it rides on top of whatever a routed program is playing.
const TONE_AMPLITUDE: f32 = 0.3;
/// Cosine ramp at each end of the burst, so it never clicks.
const TONE_FADE_MS: usize = 20;
/// Silence before the first burst and after each one. The tail lets the last
/// burst finish audibly before the next gap begins.
const LEAD_MS: usize = 500;
const TAIL_MS: usize = 900;
/// Gap between bursts, drawn per rep from this span: a fixed rhythm invites
/// anticipating the burst, and an anticipated press biases the measurement.
const GAP_MIN_MS: usize = 500;
const GAP_MAX_MS: usize = 1_200;
/// Buffer level the pump keeps. The marker-to-audible offset includes whatever
/// silence sat ahead of the burst when it was written; keeping that level fixed
/// makes the offset a per-device constant, which is all the arithmetic needs.
const PADDING_TARGET_MS: usize = 50;
/// Shared-mode stream buffer, in hundreds of nanoseconds (200 ms) — the same
/// request the engine's render clients make.
const STREAM_BUFFER_DURATION: i64 = 2_000_000;
/// Backstop for the wait on the render event: the event fires once per device
/// period while the stream is running; the timeout only bounds how long a
/// cancelled run can linger between writes.
const WAIT_BACKSTOP_MS: u32 = 250;

/// Shared state for the tone player, managed by Tauri.
///
/// `busy` admits one run at a time — two devices playing bursts into each
/// other's measurement would ruin both. `cancel` is watched between every
/// write, so closing the wizard ends the run within one backstop interval.
#[derive(Default)]
pub struct CalibrationState {
    busy: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
}

impl CalibrationState {
    /// Marks the run as started; returns `false` when one is already running.
    pub fn begin(&self) -> bool {
        self.busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    /// A cloneable handle pair for the worker thread, so the guard and the
    /// cancel flag can cross into `spawn_blocking`.
    pub fn worker_tokens(&self) -> (BusyGuard, Arc<AtomicBool>) {
        (BusyGuard(self.busy.clone()), self.cancel.clone())
    }

    /// Records the user's request to stop the current run.
    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }
}

/// Hands the busy flag back on every exit path of the worker, panics included.
pub struct BusyGuard(Arc<AtomicBool>);

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// One kernel event handle that closes itself.
struct EventHandle(HANDLE);

impl Drop for EventHandle {
    fn drop(&mut self) {
        // SAFETY: this guard is the only owner; the handle came from CreateEventW.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

/// What the pump writes next, in frames.
enum Segment {
    Silence(usize),
    Tone(usize),
}

/// A deterministic small PRNG for the gap lengths. Randomness here only has to
/// defeat rhythm-guessing, not an adversary; seeding from the clock keeps the
/// module free of a `rand` dependency.
struct GapRng(u64);

impl GapRng {
    fn next(&mut self) -> usize {
        // xorshift64*, fine for jitter.
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        let scaled = (x.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 33) as usize;
        GAP_MIN_MS + scaled % (GAP_MAX_MS - GAP_MIN_MS + 1)
    }
}

/// Play `TONE_REPS` bursts on `device_id`, bracketing each with events.
///
/// Returns when the sequence is done, or an error when the device could not be
/// opened, fails mid-stream, or the run was cancelled.
pub fn play_test_tone(
    device_id: &str,
    app: &AppHandle,
    cancel: &AtomicBool,
) -> Result<(), AudioError> {
    let com_owned = crate::audio::init_com()?;
    let result = play_test_tone_inner(device_id, app, cancel);
    crate::audio::uninit_com(com_owned);
    result
}

fn play_test_tone_inner(
    device_id: &str,
    app: &AppHandle,
    cancel: &AtomicBool,
) -> Result<(), AudioError> {
    let com_err =
        |what: &str, e: windows::core::Error| AudioError::Api(format!("{what} failed: {e}"));
    let (format, block_align, sample_rate) = default_mix_format()?;

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
        // SAFETY: unnamed auto-reset event; owned by EventHandle.
        CreateEventW(None, false, false, None).map_err(|e| com_err("CreateEventW", e))?
    };
    let event_guard = EventHandle(event);
    // SAFETY: format is a complete WAVEFORMATEX(EXTENSIBLE) copied from the
    // default device's mix format; auto-convert adapts it to this device, the
    // same path a mirror's render client takes.
    let format = unsafe { &*(format.as_ptr() as *const WAVEFORMATEX) };
    // SAFETY: shared-mode event-driven render; periodicity must be 0.
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
            .map_err(|e| com_err("Initialize(calibration)", e))?;
        client
            .SetEventHandle(event)
            .map_err(|e| com_err("SetEventHandle(calibration)", e))?;
    }
    let render: IAudioRenderClient = unsafe {
        client
            .GetService()
            .map_err(|e| com_err("GetService(IAudioRenderClient)", e))?
    };
    // SAFETY: GetBufferSize on an initialized client.
    let buffer_frames = unsafe {
        client
            .GetBufferSize()
            .map_err(|e| com_err("GetBufferSize", e))?
    } as usize;

    let schedule = build_schedule(sample_rate);
    // One burst is all the audio this run plays — every rep is the same burst.
    let burst = render_tone_frames(
        burst_frames(&schedule),
        sample_rate,
        block_align / 4, // float32 channels
    );

    // SAFETY: Start on a fully initialized client.
    unsafe {
        client
            .Start()
            .map_err(|e| com_err("Start(calibration)", e))?;
    }
    let result = pump(
        &client,
        &render,
        &schedule,
        &burst,
        block_align,
        sample_rate,
        buffer_frames,
        event_guard.0,
        cancel,
        app,
    );
    // SAFETY: Stop on a started client; errors during teardown are ignored —
    // the stream dies with the client below either way.
    unsafe {
        let _ = client.Stop();
    }
    result
}

/// The whole run as one segment list, in frames: settle, then per rep a gap,
/// a burst, and a tail that lets the burst finish audibly.
fn build_schedule(sample_rate: u32) -> Vec<Segment> {
    let frames = |ms: usize| ms * sample_rate as usize / 1000;
    let mut rng = GapRng(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos() as u64 | 1)
            .unwrap_or(0x9E37_79B9_7F4A_7C15),
    );
    let mut segments = vec![Segment::Silence(frames(LEAD_MS))];
    for _ in 0..TONE_REPS {
        segments.push(Segment::Silence(frames(rng.next())));
        segments.push(Segment::Tone(frames(TONE_BURST_MS)));
        segments.push(Segment::Silence(frames(TAIL_MS)));
    }
    segments
}

fn segment_len(segment: &Segment) -> usize {
    match segment {
        Segment::Silence(total) | Segment::Tone(total) => *total,
    }
}

/// The length of the first burst, which is what `render_tone_frames` filled.
/// Every burst in the schedule is the same length.
fn burst_frames(schedule: &[Segment]) -> usize {
    // One lead segment, then per rep (gap, tone, tail): the first tone sits at
    // index 1 + 0 * 3 + 1.
    match schedule.get(2) {
        Some(Segment::Tone(total)) => *total,
        _ => 0,
    }
}

/// Feed the device from the segment list, paced to a fixed padding target.
///
/// Every wait in this loop is woken by the device's render event (once per
/// period) or bounded by the backstop timeout, which exists so a cancelled run
/// cannot linger between writes; the cancel flag is checked on both exits.
// Tauri commands carry their State params in the signature, so the argument
// count is fixed by the framework — same allowance the route command carries.
#[allow(clippy::too_many_arguments)]
fn pump(
    client: &IAudioClient,
    render: &IAudioRenderClient,
    schedule: &[Segment],
    burst: &[f32],
    block_align: usize,
    sample_rate: u32,
    buffer_frames: usize,
    event: HANDLE,
    cancel: &AtomicBool,
    app: &AppHandle,
) -> Result<(), AudioError> {
    let com_err =
        |what: &str, e: windows::core::Error| AudioError::Api(format!("{what} failed: {e}"));
    let channels = block_align / 4;
    // The buffer level the pump keeps: the write-ahead every burst sits behind,
    // common to every device this player runs against.
    let target =
        (PADDING_TARGET_MS * sample_rate as usize / 1000).min(buffer_frames.saturating_sub(1));

    let mut seg_idx = 0usize;
    let mut seg_frame = 0usize;
    let mut rep = 0usize;
    let mut start_marked = false;
    let mut end_marked = false;

    while seg_idx < schedule.len() {
        if cancel.load(Ordering::SeqCst) {
            return Err(AudioError::Api("calibration cancelled".to_string()));
        }
        // SAFETY: valid event handle; signalled once per device period while
        // the stream runs.
        unsafe { WaitForSingleObject(event, WAIT_BACKSTOP_MS) };
        if cancel.load(Ordering::SeqCst) {
            return Err(AudioError::Api("calibration cancelled".to_string()));
        }
        // SAFETY: padding query on a started render client.
        let padding = unsafe {
            client
                .GetCurrentPadding()
                .map_err(|e| com_err("GetCurrentPadding", e))?
        } as usize;
        let free = buffer_frames.saturating_sub(padding);
        let mut budget = target.saturating_sub(padding).min(free);

        while budget > 0 && seg_idx < schedule.len() {
            let remaining = segment_len(&schedule[seg_idx]) - seg_frame;
            if remaining == 0 {
                seg_idx += 1;
                seg_frame = 0;
                continue;
            }
            let take = remaining.min(budget);
            match &schedule[seg_idx] {
                Segment::Silence(_) => {
                    // SAFETY: silent frames need no data access; the buffer is
                    // valid until ReleaseBuffer.
                    unsafe {
                        render
                            .GetBuffer(take as u32)
                            .map_err(|e| com_err("GetBuffer(silence)", e))?;
                        render
                            .ReleaseBuffer(take as u32, AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)
                            .map_err(|e| com_err("ReleaseBuffer(silence)", e))?;
                    }
                }
                Segment::Tone(_) => {
                    if !start_marked {
                        start_marked = true;
                        // The start marker rides on the first write of the
                        // burst: from here the tone is on its way to the DAC.
                        let _ = app.emit(
                            "calibration-tone",
                            json!({ "index": rep, "phase": "start" }),
                        );
                    }
                    // SAFETY: copy of exactly `take` frames into the buffer
                    // returned by GetBuffer; valid until ReleaseBuffer.
                    unsafe {
                        let dst = render
                            .GetBuffer(take as u32)
                            .map_err(|e| com_err("GetBuffer(tone)", e))?;
                        let dst =
                            core::slice::from_raw_parts_mut(dst.cast::<f32>(), take * channels);
                        dst.copy_from_slice(
                            &burst[seg_frame * channels..(seg_frame + take) * channels],
                        );
                        render
                            .ReleaseBuffer(take as u32, 0)
                            .map_err(|e| com_err("ReleaseBuffer(tone)", e))?;
                    }
                    if seg_frame + take >= segment_len(&schedule[seg_idx]) && !end_marked {
                        end_marked = true;
                        // The end marker rides on the burst's last write, so
                        // the two markers bracket exactly the burst.
                        let _ =
                            app.emit("calibration-tone", json!({ "index": rep, "phase": "end" }));
                    }
                }
            }
            seg_frame += take;
            budget -= take;
            if seg_frame >= segment_len(&schedule[seg_idx]) {
                if matches!(schedule[seg_idx], Segment::Tone(_)) {
                    rep += 1;
                    start_marked = false;
                    end_marked = false;
                }
                seg_idx += 1;
                seg_frame = 0;
            }
        }
    }
    Ok(())
}

/// The burst as interleaved float32 frames: a sine with cosine ramps at both
/// ends, identical on every channel.
fn render_tone_frames(total_frames: usize, sample_rate: u32, channels: usize) -> Vec<f32> {
    let fade_frames = (TONE_FADE_MS * sample_rate as usize / 1000).max(1);
    let mut samples = Vec::with_capacity(total_frames * channels);
    let mut phase = 0.0f32;
    let step = core::f32::consts::TAU * TONE_HZ / sample_rate as f32;
    for frame in 0..total_frames {
        let env_in = if frame < fade_frames {
            0.5 - 0.5 * (core::f32::consts::PI * frame as f32 / fade_frames as f32).cos()
        } else {
            1.0
        };
        let to_end = total_frames - frame;
        let env_out = if to_end <= fade_frames {
            0.5 - 0.5 * (core::f32::consts::PI * to_end as f32 / fade_frames as f32).cos()
        } else {
            1.0
        };
        let value = TONE_AMPLITUDE * env_in * env_out * phase.sin();
        phase += step;
        for _ in 0..channels {
            samples.push(value);
        }
    }
    samples
}
