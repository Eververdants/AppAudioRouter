//! Reading the capture format: an extensible float header is float32, and a format
//! whose arithmetic would divide by zero never reaches the ring.

use crate::audio::duplication::format::{validate_mix_format, SampleFormat};

#[test]
fn a_zero_block_align_or_sample_rate_never_reaches_the_ring_arithmetic() {
    // Trims, top-ups and ring bounds all divide by one of the two; a zero
    // panics on the render thread, so the format is refused at the start.
    assert!(validate_mix_format(8, 48_000).is_ok());
    assert!(validate_mix_format(0, 48_000).is_err());
    assert!(validate_mix_format(8, 0).is_err());
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
