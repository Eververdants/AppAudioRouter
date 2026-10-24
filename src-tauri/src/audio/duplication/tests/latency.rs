//! The latency a route reports: our pipeline depth plus what the endpoint says
//! about itself, and the rule that an unmeasured endpoint reports `None`.

use std::sync::atomic::Ordering;

use crate::audio::duplication::mix::total_latency_ms;

use super::builders::engine;

#[test]
fn the_reported_latency_is_our_pipeline_plus_the_endpoints_own() {
    let eng = engine(&[0, 0], 0, true);
    for mirror in &eng.mirrors {
        mirror.stream_latency_ms.store(12, Ordering::Relaxed);
        // 4 800 frames of base latency at 48 kHz is 100 ms, plus the 12 ms
        // the endpoint reports for itself.
        assert_eq!(total_latency_ms(&eng, mirror), Some(112));
    }
}

#[test]
fn a_mirrors_delay_shows_up_in_its_reported_latency() {
    let eng = engine(&[0, 250], 0, true);
    let mirror = &eng.mirrors[1];
    mirror.stream_latency_ms.store(10, Ordering::Relaxed);
    // 100 ms base + 250 ms of compensation + the endpoint's 10 ms.
    assert_eq!(total_latency_ms(&eng, mirror), Some(360));
}

#[test]
fn an_endpoint_that_never_reported_a_latency_has_none_to_show() {
    // Zero is "not measured", not "free": drawing 0 ms would claim the
    // device is playing the app's audio instantly.
    let eng = engine(&[0], 0, true);
    assert_eq!(total_latency_ms(&eng, &eng.mirrors[0]), None);
}
