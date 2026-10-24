//! Delay compensation as the group sees it: the earliest device is the reference,
//! every mirror holds the difference above it, and a feed tap is in the group for
//! none of that.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::audio::duplication::mirror::MirrorChannel;
use crate::audio::duplication::mix::{
    group_max_volume, group_min_delay_ms, target_frames, volume_gain,
};

use super::builders::engine;

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

/// The feed tap rides the same engine as the device copies, but it is not one
/// of them: it must not move the delay reference, the volume reference, or
/// its own target. A tap silently joining the group would pull every device
/// back to the base latency (its delay is 0) and flatten every copy's share
/// (its level is 100), and nothing on screen would explain either.
#[test]
fn a_feed_tap_is_not_part_of_the_device_group() {
    let mut shared = engine(&[300, 500], 300, true);
    for mirror in &shared.mirrors {
        mirror.volume_percent.store(40, Ordering::Relaxed);
    }
    let tap = Arc::new(MirrorChannel {
        device_id: "carrier".to_string(),
        feed_tap: true,
        ring: Mutex::new(VecDeque::new()),
        capacity: 1_000_000,
        delay_ms: AtomicI32::new(0),
        volume_percent: AtomicU32::new(100),
        enabled: AtomicBool::new(true),
        wakeups: AtomicU64::new(0),
        stream_latency_ms: AtomicU32::new(0),
        worker: Mutex::new(None),
    });
    shared.mirrors.push(Arc::clone(&tap));

    // The reference is still the primary's 300 ms, not the tap's 0.
    assert_eq!(group_min_delay_ms(&shared), 300);
    assert_eq!(target_frames(&shared, &shared.mirrors[0]), 4_800);
    assert_eq!(target_frames(&shared, &shared.mirrors[1]), 4_800 + 9_600);
    // The tap itself carries no compensation.
    assert_eq!(target_frames(&shared, &tap), 4_800);

    // The loudest *device* is still the reference, and the tap plays at the
    // programme's own level rather than a share of it.
    assert_eq!(group_max_volume(&shared), 40);
    assert_eq!(volume_gain(&shared, &shared.mirrors[0]), 1.0);
    assert_eq!(volume_gain(&shared, &tap), 1.0);
}

#[test]
fn delays_are_ignored_while_delay_sync_is_off() {
    let shared = engine(&[2_000, -3_000], 1_000, false);
    for mirror in &shared.mirrors {
        assert_eq!(target_frames(&shared, mirror), 4_800);
    }
}
