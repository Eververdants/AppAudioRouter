//! Who may stop making noise, and what ends the wait.
//!
//! The idle rule ([`should_park`]) is one window for the source and a second,
//! longer one for a mirror that still holds a delay-compensated tail; the
//! copies-lost hold is the engine's own park, and its named wake source is the
//! stop that unparks it.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use crate::audio::duplication::render::hold_after_lost_copies;
use crate::audio::duplication::shared::{
    mirror_pipeline_ms, should_park, wake_capture, ExitReason,
};
use crate::audio::duplication::SOURCE_IDLE_MS;

use super::builders::engine;

#[test]
fn a_source_that_has_never_played_goes_idle_on_schedule() {
    // `last_audio_ms` starts at zero, so an engine whose app is silent from
    // the moment its route is applied parks on the same schedule as one
    // that fell silent later.
    assert!(!should_park(SOURCE_IDLE_MS - 1, 0));
    assert!(should_park(SOURCE_IDLE_MS, 0));
}

#[test]
fn a_recent_packet_keeps_the_mirrors_playing() {
    assert!(!should_park(10_000, 10_000 - SOURCE_IDLE_MS + 1));
    assert!(should_park(10_000, 10_000 - SOURCE_IDLE_MS));
}

#[test]
fn a_timestamp_ahead_of_now_does_not_read_as_silence() {
    // Saturating subtraction, not wrapping: a stale read must not look like
    // the longest possible silence.
    assert!(!should_park(5, 10));
}

#[test]
fn a_delayed_mirror_parks_only_after_its_own_tail_played_out() {
    // 2 s of compensation puts the pipeline 2.1 s deep, so the source
    // being quiet for the plain idle window is not enough — the device is
    // still playing audio captured before the silence, and the park would
    // cut it.
    let shared = engine(&[2_000], 0, true);
    let mirror = &shared.mirrors[0];
    assert_eq!(mirror_pipeline_ms(&shared, mirror), 2_100);
    let last_audio = 0;
    assert!(!should_park(
        SOURCE_IDLE_MS + 2_000,
        last_audio + mirror_pipeline_ms(&shared, mirror)
    ));
    assert!(should_park(
        SOURCE_IDLE_MS + 2_100,
        last_audio + mirror_pipeline_ms(&shared, mirror)
    ));
    // A base-latency mirror parks on (approximately) the plain window.
    let plain = engine(&[0], 0, true);
    assert_eq!(mirror_pipeline_ms(&plain, &plain.mirrors[0]), 100);
}

#[test]
fn an_engine_that_lost_every_copy_says_copies_failed_not_playing() {
    // The hold decision and the honest `active_routes` reading both key on
    // this: pushes are no-ops for a failed mirror, so once none is enabled
    // the loopback client has no consumer and must be released. One copy
    // left standing, though, keeps the engine pumping normally.
    let shared = engine(&[0, 0], 0, true);
    assert!(!shared.all_mirrors_lost());
    shared.mirrors[0].enabled.store(false, Ordering::Relaxed);
    assert!(!shared.all_mirrors_lost());
    shared.mirrors[1].enabled.store(false, Ordering::Relaxed);
    assert!(shared.all_mirrors_lost());
}

#[test]
fn a_lost_copies_hold_ends_the_moment_a_stop_lands() {
    // The hold's named wake source, exercised for real: the thread is
    // parked, a stop sets the flag and unparks it, and the hold answers
    // with `Stopped` — not by sitting out the backstop. The fixture's pid
    // is this test process, which stays alive for the whole wait, so the
    // only way out is the stop.
    let mut shared = engine(&[0], 0, true);
    shared.pid = std::process::id();
    let shared = Arc::new(shared);
    let holding = {
        let shared = Arc::clone(&shared);
        std::thread::spawn(move || matches!(hold_after_lost_copies(&shared), ExitReason::Stopped))
    };
    loop {
        if shared
            .capture_worker
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
        {
            break;
        }
        std::thread::yield_now();
    }
    shared.shutdown.store(true, Ordering::Relaxed);
    wake_capture(&shared);
    assert!(
        holding
            .join()
            .expect("the hold thread died instead of ending"),
        "the hold ended for a reason other than the stop"
    );
}
