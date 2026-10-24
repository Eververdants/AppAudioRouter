//! Scaling the bytes: unity short-circuits, amplification is not discarded,
//! integer formats saturate, and a format that cannot be read is left alone.

use crate::audio::duplication::format::{apply_gain, SampleFormat};

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
fn gain_leaves_the_audio_alone_when_it_cannot_be_read() {
    let mut bytes = vec![7u8, 7, 7, 7];
    let before = bytes.clone();
    apply_gain(&mut bytes, SampleFormat::Unknown, 0.5);
    assert_eq!(bytes, before);
}
