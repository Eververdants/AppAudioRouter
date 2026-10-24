//! The three fixtures every topic file below builds on.
//!
//! [`channel`] is one mirror ring; [`engine`] is an [`EngineShared`] with
//! `mirror_delays.len()` mirrors over a 48 kHz capture format and a 100 ms base
//! pipeline, and [`engine_with_volumes`] is the same thing with the copies' shares
//! and the program's session volume set. Everything a test needs to *observe* is a
//! real engine field or a real group function, so these build state rather than
//! fake it.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::audio::duplication::format::SampleFormat;
use crate::audio::duplication::mirror::MirrorChannel;
use crate::audio::duplication::shared::EngineShared;
use crate::audio::levels::SourceLevels;

pub(super) fn channel(capacity: usize) -> MirrorChannel {
    MirrorChannel {
        device_id: "test".to_string(),
        feed_tap: false,
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
pub(super) fn engine(mirror_delays: &[i32], primary_ms: i32, sync: bool) -> EngineShared {
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
                    feed_tap: false,
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

/// Engine whose mirrors carry the given volumes, with the program's
/// session volume at `session_percent`.
pub(super) fn engine_with_volumes(mirror_percents: &[u32], session_percent: u32) -> EngineShared {
    let shared = engine(&vec![0; mirror_percents.len()], 0, true);
    for (mirror, percent) in shared.mirrors.iter().zip(mirror_percents) {
        mirror.volume_percent.store(*percent, Ordering::Relaxed);
    }
    shared
        .session_volume_percent
        .store(session_percent, Ordering::Relaxed);
    shared
}

/// An engine that exists only to carry a feed tap into the carrier: no device
/// of the board is served by it, so no route answers for it.
pub(super) fn tap_engine() -> EngineShared {
    let mut shared = engine(&[], 0, true);
    shared.mirrors.push(Arc::new(MirrorChannel {
        device_id: "cable-in".to_string(),
        feed_tap: true,
        ..channel(1_000_000)
    }));
    shared
}
