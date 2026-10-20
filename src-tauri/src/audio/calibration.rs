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
//!
//! The run is parameterized (`reps`, `lead_ms`, `tail_ms`) because the wizard
//! interleaves devices: instead of one long per-device sequence it drives one
//! short burst per call, rotating through the devices round by round. That
//! rotation keeps whatever drifts in the user's reaction time over a session
//! (warming up, tiring) common to every device, instead of biasing whichever
//! one happened to be measured first. Between calls the frontend draws a fresh
//! random lead, so the pace stays unpredictable across the whole session; the
//! short tail between calls is safe because the pump paces its writes at the
//! fixed padding target — by the time a schedule ends, the burst is already
//! audible and only padding-depth silence remains in the buffer.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use log::{debug, warn};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, WAIT_FAILED};
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
/// Bursts per run when the caller does not choose. Three presses average out
/// the reaction jitter; the frontend discards a press whose hold duration does
/// not match the burst.
pub const TONE_REPS_DEFAULT: usize = 3;
/// Upper bound on caller-supplied bursts: the wizard's round-robin re-enters
/// this command once per burst, so one call must never turn into a marathon.
pub const TONE_REPS_MAX: usize = 6;
/// Silence before the first burst, and after each one. The tail lets a burst
/// finish audibly before the schedule ends. The wizard's round-robin passes a
/// shorter tail per call and randomizes the lead itself (see the module doc);
/// these defaults describe a standalone single-device sequence.
pub const LEAD_MS_DEFAULT: usize = 500;
pub const TAIL_MS_DEFAULT: usize = 900;
/// Hard bounds for caller-supplied lead and tail: short enough to keep the
/// pace snappy and the gaps obviously audible, long enough that a burst is
/// never clipped and the rhythm cannot be guessed from a constant.
const LEAD_MS_MIN: usize = 100;
const LEAD_MS_MAX: usize = 2_000;
const TAIL_MS_MIN: usize = 100;
const TAIL_MS_MAX: usize = 2_000;
/// Pitch of the burst: comfortably audible on every consumer device.
const TONE_HZ: f32 = 880.0;
/// Peak amplitude of the burst: clearly audible without startle, and quiet
/// enough that it rides on top of whatever a routed program is playing.
const TONE_AMPLITUDE: f32 = 0.3;
/// Cosine ramp at each end of the burst, so it never clicks.
const TONE_FADE_MS: usize = 20;
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
/// The stream flags a burst is written with: the device event, plus the
/// conversion pair that lets a format taken from the **default** endpoint be
/// opened on any other one. Same request the engine's mirror clients make.
const FLAGS_WITH_CONVERSION: u32 = AUDCLNT_STREAMFLAGS_EVENTCALLBACK
    | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
    | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
/// Backstop for the wait on the render event: the event fires once per device
/// period while the stream is running; the timeout only bounds how long a
/// cancelled run can linger between writes.
const WAIT_BACKSTOP_MS: u32 = 250;
/// `WAVEFORMATEX.wFormatTag` values the burst's own format has to be read against.
const WAVE_FORMAT_IEEE_FLOAT: u16 = 0x0003;
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;

/// The run token a caller that names no run uses.
///
/// A start carrying it is never refused for staleness, because there is nothing
/// to match: the shell's window teardown, which is the caller that names no run,
/// keeps the behaviour the player had before runs were counted, and only a
/// caller that passes a real token gets the stale-start refusal. Zero is free for
/// that purpose because a real token names one run and is never reused — not by
/// a later run of the page that minted it, and not by a page reloaded over a
/// mark the earlier one left (`DelayCalibration`'s `mintRunToken`).
pub const NO_RUN_TOKEN: u64 = 0;

/// Why the tone player did not admit a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// Another burst is already playing: two devices sounding into each other's
    /// measurement would ruin both.
    Busy,
    /// The wizard had already cancelled this run by the time the request reached
    /// the player, so playing now would sound into a dialog that is gone.
    Cancelled,
}

impl Refusal {
    /// The words `calibration_start` answers with.
    ///
    /// Both cases say something the wizard can sort without guessing. A stale
    /// start says `calibration superseded`: the run it was going to play has
    /// already been called off, so the loop that awaited it must not read a
    /// measurement into a burst nobody heard — and by construction the wizard that
    /// cancelled is no longer on the measure screen, which is why it may also treat
    /// the phrase as its own doing. The busy case deliberately says neither of the
    /// cancellation phrases, because a start refused while a burst nobody cancelled
    /// is still sounding is a failure worth showing.
    pub fn message(&self) -> &'static str {
        match self {
            Refusal::Busy => "a calibration run is already in progress",
            Refusal::Cancelled => {
                "calibration superseded (this run was cancelled before it started)"
            }
        }
    }
}

/// Shared state for the tone player, managed by Tauri.
///
/// `busy` admits one run at a time — two devices playing bursts into each
/// other's measurement would ruin both. `cancel` is watched between every
/// write, so closing the wizard ends the run within one backstop interval.
///
/// `generation` counts the cancels this player has taken. `cancelled_run` holds
/// the run identity the most recent of them named, and `stale_generation` the
/// generation of a cancel that found nothing sounding. Those three answer the one
/// question the player could not answer before: whether the start now being
/// admitted was asked for *before* the user said stop. See
/// [`CalibrationState::begin`].
#[derive(Default)]
pub struct CalibrationState {
    busy: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
    generation: AtomicU64,
    cancelled_run: AtomicU64,
    stale_generation: AtomicU64,
}

impl CalibrationState {
    /// Admit the run `run` identifies; `NO_RUN_TOKEN` for a caller that names none.
    ///
    /// A start is refused as stale when the user had already called this run off
    /// while the request was still in flight. That race is real and one-sided: the
    /// wizard awaits one burst at a time, so its Escape can be handled here
    /// *before* the start it was pressing Escape about has been admitted (the
    /// cancel runs on the IPC thread, the start body on the runtime's worker).
    /// Without the check the start clears the cancel flag the cancel had just set
    /// and the burst sounds into a dialog the user has already closed — the
    /// frontend can re-cancel the late answer and hope, but only the player can
    /// tell a cancel from the start it outranks.
    ///
    /// Two ways to tell, because the caller may or may not name its run:
    ///
    /// * a named cancel records the run it meant, and a start carrying that same
    ///   token is by construction older than it — precise, and never in the way of
    ///   any other run;
    /// * an unnamed cancel that finds **no burst sounding** can only have been sent
    ///   against a start that has not been admitted yet (a caller that names no run
    ///   asks to stop only while a loop of its own is measuring, and while a burst
    ///   is admitted `busy` is set), so it marks the generation and the next start
    ///   to arrive is refused.
    ///
    /// Either mark is spent by the refusal it was aimed at, so a run that comes
    /// afterwards is never refused twice, and a start that arrives while one is
    /// playing is refused as busy *without* disturbing the live run's cancel flag
    /// or a mark another start still owns.
    pub fn begin(&self, run: u64) -> Result<(), Refusal> {
        if run != NO_RUN_TOKEN && self.cancelled_run.load(Ordering::SeqCst) == run {
            // Consumed only for the run it names: a cancel aimed at this start
            // cannot also be a cancel the next start has to survive.
            let _ = self.cancelled_run.compare_exchange(
                run,
                NO_RUN_TOKEN,
                Ordering::SeqCst,
                Ordering::SeqCst,
            );
            return Err(Refusal::Cancelled);
        }
        if self.stale_generation.swap(NO_RUN_TOKEN, Ordering::SeqCst) != NO_RUN_TOKEN {
            return Err(Refusal::Cancelled);
        }
        if self
            .busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(Refusal::Busy);
        }
        // A fresh run must not inherit the previous run's cancel request. The
        // flag is never cleared on the way out, so without this every run after
        // the first cancel would fail at once — and the wizard reads
        // "calibration cancelled" as its own doing, leaving the measure screen
        // standing with neither a burst nor an error to explain it.
        self.cancel.store(false, Ordering::SeqCst);
        Ok(())
    }

    /// A cloneable handle pair for the worker thread, so the guard and the
    /// cancel flag can cross into `spawn_blocking`.
    pub fn worker_tokens(&self) -> (BusyGuard, Arc<AtomicBool>) {
        (BusyGuard(self.busy.clone()), self.cancel.clone())
    }

    /// Records the user's request to stop the run `run`, which may be
    /// `NO_RUN_TOKEN` when the caller names none.
    ///
    /// The flag is set whichever way: a cancel must always reach the burst that is
    /// sounding right now, and the marks only decide what may still *begin*.
    pub fn cancel(&self, run: u64) {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if run == NO_RUN_TOKEN {
            // No run named, so the ordering has to be inferred from what was
            // sounding: nothing was, which means the start this cancel answers has
            // not reached `begin` yet.
            if !self.is_running() {
                self.stale_generation.store(generation, Ordering::SeqCst);
            }
        } else {
            self.cancelled_run.store(run, Ordering::SeqCst);
        }
        self.cancel.store(true, Ordering::SeqCst);
        if run == NO_RUN_TOKEN {
            debug!("calibration cancelled at generation {generation}");
        } else {
            debug!("calibration run {run} cancelled at generation {generation}");
        }
    }

    /// How many cancels this player has taken. A run's start and its cancel are
    /// told apart by nothing else on this side, so the count is what the log and
    /// the tests read.
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// Whether a run is playing right now.
    pub fn is_running(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }
}

/// Stop the burst that is sounding because nobody can hear it any more.
///
/// The window going away is the shell's knowledge, not the page's: hidden to the
/// tray the React tree never unmounts, so nothing calls `calibration_cancel`, and
/// a lost webview could not call it if it wanted to. Cancelling is a store on an
/// atomic — no join, no lock, nothing the event loop can be held by — and the pump
/// ends itself within one backstop interval, so this returns while the burst is
/// still winding down rather than waiting for it.
///
/// Returns whether a run was standing to be stopped, so the caller can say which
/// window events actually cost a burst — and logs nothing, because it is the shell
/// that knows why the window went away.
pub fn cancel_live_run(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<CalibrationState>() else {
        return false;
    };
    if !state.is_running() {
        return false;
    }
    state.cancel(NO_RUN_TOKEN);
    true
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

/// Play `reps` bursts on `device_id`, bracketing each with events.
///
/// `lead_ms` is the silence before the first burst, `tail_ms` the silence
/// after each one; caller-supplied values are clamped to sane bounds. Returns
/// when the sequence is done, or an error when the device could not be
/// opened, fails mid-stream, or the run was cancelled.
pub fn play_test_tone(
    device_id: &str,
    reps: usize,
    lead_ms: usize,
    tail_ms: usize,
    app: &AppHandle,
    cancel: &AtomicBool,
) -> Result<(), AudioError> {
    let reps = reps.clamp(1, TONE_REPS_MAX);
    let lead_ms = lead_ms.clamp(LEAD_MS_MIN, LEAD_MS_MAX);
    let tail_ms = tail_ms.clamp(TAIL_MS_MIN, TAIL_MS_MAX);
    let com_owned = crate::audio::init_com()?;
    let result = play_test_tone_inner(device_id, reps, lead_ms, tail_ms, app, cancel);
    crate::audio::uninit_com(com_owned);
    result
}

/// The mix format's channel count, and whether the burst's float32 frames can
/// be written into it as they stand.
///
/// The channel count cannot be had from `nBlockAlign / 4`: that is the frame
/// size of a 32-bit format, and a device handing back 16-bit stereo would read
/// as mono. The encoding matters for the same reason — a mix format is float32
/// in practice but may come back as extensible integer PCM, and float32 bytes
/// written into a PCM buffer are noise, not a tone.
fn mix_layout(format: &[u8]) -> (usize, bool) {
    /// Offset of `SubFormat` inside a `WAVEFORMATEXTENSIBLE`, and the first four
    /// bytes of `KSDATAFORMAT_SUBTYPE_IEEE_FLOAT` as laid out in memory (the
    /// GUID's first field is little-endian).
    const SUBFORMAT_OFFSET: usize = 24;
    const FLOAT_SUBTYPE: [u8; 4] = [0x03, 0x00, 0x00, 0x00];
    /// `WAVEFORMATEX` (18 bytes) plus the 22 bytes the extensible form appends.
    const EXTENSIBLE_LEN: usize = 40;

    if format.len() < core::mem::size_of::<WAVEFORMATEX>() {
        return (0, false);
    }
    // SAFETY: the length was checked above, and WAVEFORMATEX is packed, so
    // reading it from an unaligned byte slice is sound.
    let wfx = unsafe { &*(format.as_ptr() as *const WAVEFORMATEX) };
    let float = match wfx.wFormatTag {
        WAVE_FORMAT_IEEE_FLOAT => wfx.wBitsPerSample == 32,
        WAVE_FORMAT_EXTENSIBLE if format.len() >= EXTENSIBLE_LEN => {
            format[SUBFORMAT_OFFSET..SUBFORMAT_OFFSET + 4] == FLOAT_SUBTYPE
                && wfx.wBitsPerSample == 32
        }
        _ => false,
    };
    (wfx.nChannels as usize, float)
}

/// The stream flags to try, in order, for one calibration burst.
///
/// The engine's render clients retry without `AUTOCONVERTPCM` when an endpoint
/// refuses the conversion path (`duplication.rs`, `open_render_session`), and
/// this player has to as well: a device that says no to the flag is a wizard
/// that reports a failure where it could have reported a measurement.
///
/// The fallback is only offered when the frames being written already are
/// float32 (`native_float`). A device that mixes in integer PCM gets the
/// synthesized float32 format instead, and that format is only meaningful
/// *with* the conversion flag — a stream opened without it takes the bytes it
/// is handed as its own format, so the burst would land as noise rather than as
/// the tone being measured. A plain retry there is a wrong answer, not a
/// fallback.
fn init_attempts(native_float: bool) -> (u32, Option<u32>) {
    (
        FLAGS_WITH_CONVERSION,
        native_float.then_some(AUDCLNT_STREAMFLAGS_EVENTCALLBACK),
    )
}

fn play_test_tone_inner(
    device_id: &str,
    reps: usize,
    lead_ms: usize,
    tail_ms: usize,
    app: &AppHandle,
    cancel: &AtomicBool,
) -> Result<(), AudioError> {
    let com_err =
        |what: &str, e: windows::core::Error| AudioError::Api(format!("{what} failed: {e}"));
    let (mix_format, _, sample_rate) = default_mix_format()?;
    let (channels, native_float) = mix_layout(&mix_format);

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
    // The render event is created *before* the client that will be handed it, and
    // owns it in a guard declared ahead of the client, so that the order holds on
    // every path out of this function and not only on the planned one: locals drop
    // in reverse declaration order, and `SetEventHandle` gives the client the
    // handle value. A guard declared after the client would close that handle
    // first on any early return — `GetService`, `GetBufferSize`, `Start` — and a
    // closed handle value is one another thread can be given for a different
    // object, which the engine would then be signalling instead of this stream.
    // Same shape as `duplication`'s `RenderSession`, whose client drops before the
    // handle field it owns.
    let event = unsafe {
        // SAFETY: unnamed auto-reset event; owned by EventHandle.
        CreateEventW(None, false, false, None).map_err(|e| com_err("CreateEventW", e))?
    };
    let event_guard = EventHandle(event);
    // SAFETY: activating IAudioClient on an active render device.
    let client: IAudioClient = unsafe {
        device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| com_err("Activate(IAudioClient)", e))?
    };
    // The stream is described by the default device's own mix format whenever
    // that format can carry the burst; auto-convert adapts it to this device,
    // the same path a mirror's render client takes. A device that mixes in
    // integer PCM gets an equivalent float32 stream instead, which the
    // auto-convert flag above already asks the engine to adapt — the burst is
    // generated as float32 and cannot be written into a PCM buffer as it is.
    let float32_format = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
        nChannels: channels as u16,
        nSamplesPerSec: sample_rate,
        nAvgBytesPerSec: sample_rate * channels as u32 * 4,
        nBlockAlign: (channels * 4) as u16,
        wBitsPerSample: 32,
        cbSize: 0,
    };
    // SAFETY: mix_format is a complete WAVEFORMATEX(EXTENSIBLE) copied from the
    // default device's mix format; the 18-byte prefix is valid for either shape.
    let mix = unsafe { &*(mix_format.as_ptr() as *const WAVEFORMATEX) };
    let format = if native_float { mix } else { &float32_format };
    let (flags, fallback_flags) = init_attempts(native_float);
    // SAFETY: shared-mode event-driven render; periodicity must be 0, and
    // `format` outlives both calls. A client whose Initialize failed is still
    // uninitialized, so the fallback attempt is allowed on the same client —
    // which is how the engine's own render clients do it.
    let initialized = unsafe {
        client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                flags,
                STREAM_BUFFER_DURATION,
                0,
                format,
                None,
            )
            .or_else(|first_error| match fallback_flags {
                None => Err(first_error),
                Some(plain) => client
                    .Initialize(
                        AUDCLNT_SHAREMODE_SHARED,
                        plain,
                        STREAM_BUFFER_DURATION,
                        0,
                        format,
                        None,
                    )
                    .map_err(|retry_error| {
                        warn!("calibration retry without auto-convert failed: {retry_error}");
                        first_error
                    }),
            })
    };
    initialized.map_err(|e| com_err("Initialize(calibration)", e))?;
    // SAFETY: valid handle; the client is event-driven, so the handle must stay
    // valid for the lifetime of the stream. Must come after Initialize.
    unsafe {
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
    // A device that answers "no frames" cannot be paced at all: the padding
    // target clamps to 0, so the pump would write nothing, wait, and repeat —
    // holding the single run slot for the rest of the session with a burst that
    // never advances and never ends. The wizard needs its failure, not a busy
    // player, so say so here.
    if buffer_frames == 0 {
        return Err(AudioError::Api(
            "the device reported an empty render buffer".to_string(),
        ));
    }

    let schedule = build_schedule(sample_rate, reps, lead_ms, tail_ms);
    // One burst is all the audio this run plays — every rep is the same burst.
    let burst = render_tone_frames(burst_frames(&schedule), sample_rate, channels);

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
        channels,
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
    // The client goes before the event handle it was given, and before the render
    // client drawn from it: nothing may hold a write interface against a released
    // audio client, and nothing may outlive the handle the audio client still
    // names. The declaration order above already guarantees the handle for the
    // early returns; these two lines are the same order for the planned one.
    drop(render);
    drop(client);
    result
}

/// The whole run as one segment list, in frames: settle, then per rep a gap,
/// a burst, and a tail that lets the burst finish audibly.
fn build_schedule(sample_rate: u32, reps: usize, lead_ms: usize, tail_ms: usize) -> Vec<Segment> {
    let frames = |ms: usize| ms * sample_rate as usize / 1000;
    let mut rng = GapRng(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos() as u64 | 1)
            .unwrap_or(0x9E37_79B9_7F4A_7C15),
    );
    let mut segments = vec![Segment::Silence(frames(lead_ms))];
    for _ in 0..reps {
        segments.push(Segment::Silence(frames(rng.next())));
        segments.push(Segment::Tone(frames(TONE_BURST_MS)));
        segments.push(Segment::Silence(frames(tail_ms)));
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
/// cannot linger between writes; the cancel flag is checked on both exits, and a
/// wait that fails outright ends the run rather than spinning it (see below).
// Tauri commands carry their State params in the signature, so the argument
// count is fixed by the framework — same allowance the route command carries.
#[allow(clippy::too_many_arguments)]
fn pump(
    client: &IAudioClient,
    render: &IAudioRenderClient,
    schedule: &[Segment],
    burst: &[f32],
    channels: usize,
    sample_rate: u32,
    buffer_frames: usize,
    event: HANDLE,
    cancel: &AtomicBool,
    app: &AppHandle,
) -> Result<(), AudioError> {
    let com_err =
        |what: &str, e: windows::core::Error| AudioError::Api(format!("{what} failed: {e}"));
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
        // the stream runs, and a timeout is the expected answer between periods.
        let waited = unsafe { WaitForSingleObject(event, WAIT_BACKSTOP_MS) };
        if waited == WAIT_FAILED {
            // The handle is not waitable any more, so the wait returns at once
            // instead of pacing the loop: carrying on would spin this thread at
            // full tilt while writing the burst as fast as the buffer allows,
            // which is the opposite of a predictable measurement.
            // SAFETY: GetLastError only reads this thread's last-error slot.
            let code = unsafe { GetLastError() };
            return Err(AudioError::Api(format!(
                "WaitForSingleObject(calibration) failed: 0x{:08X}",
                code.0
            )));
        }
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
                        // It is the measurement, not a courtesy: a marker the
                        // window never got leaves the wizard scoring the next
                        // tap against the previous burst, so the failure is
                        // logged rather than swallowed.
                        if let Err(e) = app.emit(
                            "calibration-tone",
                            json!({ "index": rep, "phase": "start" }),
                        ) {
                            warn!("could not deliver the tone start marker: {e}");
                        }
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
                        if let Err(e) =
                            app.emit("calibration-tone", json!({ "index": rep, "phase": "end" }))
                        {
                            warn!("could not deliver the tone end marker: {e}");
                        }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The wizard cancels freely — Escape, the cancel button, unmount — and
    /// then measures again from the same screen. A cancel request that outlived
    /// its run would fail every later run at the pump's first check, which the
    /// frontend reads as its own doing and swallows: the wizard would sit on
    /// the measure screen with no burst and no error until the app restarted.
    #[test]
    fn a_new_run_does_not_inherit_the_previous_cancel() {
        let state = CalibrationState::default();
        assert_eq!(
            state.begin(NO_RUN_TOKEN),
            Ok(()),
            "the first run is admitted"
        );
        let (_guard, cancel) = state.worker_tokens();
        state.cancel(NO_RUN_TOKEN);
        assert!(
            cancel.load(Ordering::SeqCst),
            "the running run is cancellable"
        );
        drop(_guard);

        assert_eq!(
            state.begin(NO_RUN_TOKEN),
            Ok(()),
            "the run is over, so the next one is admitted"
        );
        let (_guard, cancel) = state.worker_tokens();
        assert!(
            !cancel.load(Ordering::SeqCst),
            "the fresh run must not start pre-cancelled"
        );

        // A second begin while one runs is refused, and must not disturb the
        // running run's cancel flag.
        assert_eq!(state.begin(NO_RUN_TOKEN), Err(Refusal::Busy));
        assert!(
            !cancel.load(Ordering::SeqCst),
            "the refused start left the live run's flag alone"
        );
        state.cancel(NO_RUN_TOKEN);
        assert!(cancel.load(Ordering::SeqCst));
    }

    /// The race the run counter exists for. The wizard awaits one burst at a
    /// time and its Escape goes on the IPC thread, so a cancel can be handled
    /// before the start it was answering has been admitted: without a refusal,
    /// that start clears the flag the cancel just set and the burst sounds into a
    /// dialog the user already closed. The frontend can only re-cancel the late
    /// answer and hope; the player knows which side arrived first.
    #[test]
    fn a_start_older_than_the_last_cancel_is_refused() {
        let state = CalibrationState::default();
        // Nothing was playing when the cancel arrived, so all it leaves behind is
        // its mark on run 7.
        state.cancel(7);
        assert_eq!(state.generation(), 1, "the cancel moved the run generation");
        assert!(
            !state.is_running(),
            "a cancel with nothing playing starts nothing"
        );

        assert_eq!(
            state.begin(7),
            Err(Refusal::Cancelled),
            "a start the user already cancelled is refused"
        );
        assert!(
            Refusal::Cancelled.message().contains("superseded"),
            "the refusal names the wizard's own phrase for a run called off under it"
        );
        assert!(
            !Refusal::Busy.message().contains("superseded"),
            "a collision nobody caused stays reportable"
        );
        assert!(!state.is_running(), "a refused start did not take the slot");

        // The refusal spends the cancel it was aimed at, so the retry — which is a
        // new run, and a new run carries a new token — gets its burst, and gets it
        // un-cancelled.
        assert_eq!(state.begin(8), Ok(()));
        assert!(state.is_running());
        let (_guard, cancel) = state.worker_tokens();
        assert!(
            !cancel.load(Ordering::SeqCst),
            "the retried run is not pre-cancelled"
        );
    }

    /// The same race as above for a wizard that names no run — which is the one
    /// shipping today. A cancel that finds no burst sounding cannot have been sent
    /// against a run the player has admitted (that is what `busy` says), so the
    /// only thing it can be answering is a start still in flight, and that start
    /// is refused when it lands. A cancel that finds a burst playing needs no mark
    /// at all: it stops it.
    #[test]
    fn a_cancel_with_nothing_playing_outranks_the_next_start() {
        let state = CalibrationState::default();
        {
            // A cancel over a run that is sounding leaves no mark behind: the burst
            // it stops is in front of the player's eyes.
            assert_eq!(state.begin(NO_RUN_TOKEN), Ok(()));
            let (_guard, cancel) = state.worker_tokens();
            state.cancel(NO_RUN_TOKEN);
            assert!(cancel.load(Ordering::SeqCst), "the live burst is stopped");
        }

        // Idle now, so this cancel cannot be answering a run the player admitted —
        // only a start that has not landed yet.
        state.cancel(NO_RUN_TOKEN);
        assert_eq!(
            state.begin(NO_RUN_TOKEN),
            Err(Refusal::Cancelled),
            "the start that was still in flight is refused instead of played"
        );
        assert_eq!(
            state.begin(NO_RUN_TOKEN),
            Ok(()),
            "and the mark is spent, so the run after it plays"
        );
    }

    /// A cancel must always reach the burst that is sounding, whichever run the
    /// caller meant it for — and naming a run must never be what stops the *next*
    /// one from playing.
    #[test]
    fn a_cancel_stops_what_is_playing_and_refuses_only_the_run_it_named() {
        let state = CalibrationState::default();
        assert_eq!(state.begin(1), Ok(()));
        let (_guard, cancel) = state.worker_tokens();
        // Aimed at a run that never started; the live burst still ends.
        state.cancel(99);
        assert!(
            cancel.load(Ordering::SeqCst),
            "a cancel nobody can match still stops the sound"
        );
        drop(_guard);

        assert_eq!(
            state.begin(2),
            Ok(()),
            "a cancel for another run refuses nothing else"
        );
        let (_guard, cancel) = state.worker_tokens();
        assert!(
            !cancel.load(Ordering::SeqCst),
            "and the run that plays afterwards is not pre-cancelled"
        );
    }

    /// A `WAVEFORMATEX` as the raw bytes `default_mix_format` hands over.
    fn wave_format(tag: u16, channels: u16, bits: u16, rate: u32) -> Vec<u8> {
        let align = channels * (bits / 8);
        let wfx = WAVEFORMATEX {
            wFormatTag: tag,
            nChannels: channels,
            nSamplesPerSec: rate,
            nAvgBytesPerSec: rate * align as u32,
            nBlockAlign: align,
            wBitsPerSample: bits,
            cbSize: 0,
        };
        // SAFETY: WAVEFORMATEX is packed and holds no padding or ownership.
        unsafe {
            core::slice::from_raw_parts(
                &wfx as *const WAVEFORMATEX as *const u8,
                core::mem::size_of::<WAVEFORMATEX>(),
            )
        }
        .to_vec()
    }

    /// The extensible form, whose `SubFormat` at offset 24 says float or PCM.
    fn extensible(subformat: u32, channels: u16, bits: u16, rate: u32) -> Vec<u8> {
        let mut bytes = wave_format(WAVE_FORMAT_EXTENSIBLE, channels, bits, rate);
        bytes.resize(40, 0);
        bytes[16..18].copy_from_slice(&22u16.to_le_bytes());
        bytes[24..28].copy_from_slice(&subformat.to_le_bytes());
        bytes
    }

    /// The burst's channel count and encoding both come out of the mix format,
    /// and a device that mixes in integer PCM is rare but real. Read off
    /// `nBlockAlign / 4`, 16-bit stereo — a four-byte frame — names one channel
    /// instead of two, and float32 bytes written into a PCM buffer are noise
    /// rather than a tone.
    #[test]
    fn the_mix_format_decides_the_channel_count_and_whether_float32_fits() {
        const PCM: u16 = 0x0001;
        const IEEE_FLOAT: u32 = 3;
        const SUBTYPE_PCM: u32 = 1;

        assert_eq!(mix_layout(&wave_format(PCM, 2, 16, 48_000)), (2, false));
        assert_eq!(mix_layout(&wave_format(PCM, 2, 32, 48_000)), (2, false));
        assert_eq!(
            mix_layout(&wave_format(WAVE_FORMAT_IEEE_FLOAT, 2, 32, 48_000)),
            (2, true),
            "the everyday mix format is written as it comes"
        );
        assert_eq!(
            mix_layout(&extensible(IEEE_FLOAT, 6, 32, 48_000)),
            (6, true)
        );
        assert_eq!(
            mix_layout(&extensible(SUBTYPE_PCM, 2, 16, 48_000)),
            (2, false)
        );
        // A format too short to read at all is not float32, whatever it claims.
        assert_eq!(mix_layout(&[0u8; 4]), (0, false));
    }

    /// An endpoint that refuses `AUTOCONVERTPCM` still takes a plain stream, and
    /// the wizard has to find out by trying — but only when the frames it writes
    /// are the device's own. On an integer-PCM mixer the burst is synthesized as
    /// float32, and a stream opened without conversion would read those bytes as
    /// its own format: the fallback exists to save a measurement, not to turn it
    /// into noise.
    #[test]
    fn the_plain_retry_is_only_offered_to_a_device_that_mixes_in_float32() {
        let (convert, fallback) = init_attempts(true);
        assert_eq!(convert, FLAGS_WITH_CONVERSION);
        assert_eq!(fallback, Some(AUDCLNT_STREAMFLAGS_EVENTCALLBACK));
        assert_eq!(
            init_attempts(false),
            (FLAGS_WITH_CONVERSION, None),
            "no plain attempt against a PCM mixer"
        );
        // The conversion attempt always asks for the flag it is falling back
        // from, so a device that took the first call is never retried wrong.
        assert!(convert & AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM != 0);
        assert!(convert & AUDCLNT_STREAMFLAGS_EVENTCALLBACK != 0);
    }
}
