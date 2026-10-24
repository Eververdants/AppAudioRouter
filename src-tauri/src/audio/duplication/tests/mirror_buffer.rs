//! One mirror's ring: frame alignment, the capacity cap, the silence a delay
//! puts in front of the audio, and what a mirror out of service does with all of
//! it.

use std::sync::atomic::Ordering;

use super::builders::channel;

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
