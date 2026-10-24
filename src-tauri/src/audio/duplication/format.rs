//! The shape of the audio bytes: the capture format, what one sample of it is,
//! and the two walks that read or scale a chunk of them.
//!
//! [`default_mix_format`] is the format every engine speaks (and the calibration
//! player's too), [`SampleFormat`] decodes how one sample of it is stored, and
//! [`measure_chunk`] / [`apply_gain`] are the only places that walk the buffer
//! sample by sample. Both of those refuse to guess: a format the engine does not
//! recognize is left out of the level estimate and untouched by a gain, rather
//! than read as silence or mangled — see [`validate_mix_format`] for the other
//! half of "a broken device format never reaches the arithmetic".

use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator, WAVEFORMATEX,
};
use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL};

use crate::audio::AudioError;

/// How one sample is stored in the shared capture format.
///
/// Windows mix formats are float32 in practice, but a device may hand back
/// extensible PCM, so the integer widths are handled as well. A format this
/// engine does not understand leaves the audio untouched rather than mangled.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SampleFormat {
    Float32,
    Float64,
    /// Signed little-endian integers, 2, 3 or 4 bytes wide.
    Int(usize),
    /// Not scaled; per-device volume is skipped for the stream.
    Unknown,
}

impl SampleFormat {
    /// Read the format out of a `WAVEFORMATEX`, which may be extensible.
    pub(super) fn parse(format: &[u8]) -> Self {
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

/// Peak and mean square of one chunk of interleaved samples, both as fractions
/// of full scale, or `None` for a format whose samples cannot be read.
///
/// A format this does not understand is left out of the estimate rather than
/// counted as silence: reporting a program as quiet when it is merely
/// unreadable would have an alignment amplify it.
pub(super) fn measure_chunk(bytes: &[u8], format: SampleFormat) -> Option<(f32, f32)> {
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
pub(super) fn apply_gain(bytes: &mut [u8], format: SampleFormat, gain: f32) {
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
pub(super) fn validate_mix_format(block_align: usize, sample_rate: u32) -> Result<(), AudioError> {
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
