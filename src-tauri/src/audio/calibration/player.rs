//! The device side of a run: open one endpoint, hand it to the pump, close it.
//!
//! [`play_test_tone`] is the entry the `calibration_start` command calls on a
//! blocking thread; it owns the COM apartment for that thread and nothing else.
//! [`play_test_tone_inner`] then asks the endpoint for its own mix format, opens
//! an event-driven shared stream sized like the engine's mirror clients, and lets
//! [`super::pump`] feed it — one burst at a time, because [`super::state`] admitted
//! only one run.
//!
//! The format decision is the delicate part. A burst is synthesized as float32, so
//! [`mix_layout`] reads the real channel count and encoding out of the mix format's
//! bytes — `nBlockAlign / 4` would call 16-bit stereo mono, and float32 written into
//! a PCM buffer is noise, not a tone — and [`init_attempts`] only offers the plain
//! retry when the frames already are the device's own, mirroring what
//! `duplication`'s render clients do.
//!
//! Declared in this order because the drop order has to be it: the render event's
//! [`EventHandle`] is created before the client that is handed the handle, so an
//! early return cannot close a handle a live audio client still names.

use std::sync::atomic::AtomicBool;

use log::warn;
use tauri::AppHandle;
use windows::core::PCWSTR;
use windows::Win32::Media::Audio::{
    IAudioClient, IAudioRenderClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, WAVEFORMATEX,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
use windows::Win32::System::Threading::CreateEventW;

use crate::audio::duplication::default_mix_format;
use crate::audio::AudioError;

use super::pump::pump;
use super::schedule::{
    build_schedule, burst_frames, render_tone_frames, LEAD_MS_MAX, LEAD_MS_MIN, TAIL_MS_MAX,
    TAIL_MS_MIN,
};
use super::state::EventHandle;
use super::TONE_REPS_MAX;

/// Shared-mode stream buffer, in hundreds of nanoseconds (200 ms) — the same
/// request the engine's render clients make.
const STREAM_BUFFER_DURATION: i64 = 2_000_000;
/// The stream flags a burst is written with: the device event, plus the
/// conversion pair that lets a format taken from the **default** endpoint be
/// opened on any other one. Same request the engine's mirror clients make.
const FLAGS_WITH_CONVERSION: u32 = AUDCLNT_STREAMFLAGS_EVENTCALLBACK
    | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
    | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
/// `WAVEFORMATEX.wFormatTag` values the burst's own format has to be read against.
const WAVE_FORMAT_IEEE_FLOAT: u16 = 0x0003;
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;

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

#[cfg(test)]
mod tests {
    use super::*;

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
