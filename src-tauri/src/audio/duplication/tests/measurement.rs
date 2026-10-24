//! The level estimate: what one chunk measures as a fraction of full scale, how
//! the running estimate smooths and releases, and the units it is published in.

use std::sync::atomic::Ordering;

use crate::audio::duplication::format::{measure_chunk, SampleFormat};
use crate::audio::duplication::metering::{
    measure_into, LevelTracker, LEVEL_WINDOW_MS, PEAK_RELEASE_MS,
};

use super::builders::engine;

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
