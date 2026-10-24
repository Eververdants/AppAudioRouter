//! What the engine report says: the devices a route is serving, the held
//! engine that lost every copy, and the tap-only engine that is no route at
//! all. This is the picture the frontend's reconciliation rebuilds the board
//! from, so its shape is the difference between a stoppable route and a pin
//! nothing on screen can reach.

use std::sync::atomic::Ordering;

use crate::audio::duplication::inventory::route_of;

use super::builders::{engine, tap_engine};

#[test]
fn a_route_lists_the_primary_then_the_copies_in_order() {
    let mut shared = engine(&[0, 40], 0, true);
    shared.generation = 3;
    // One endpoint has reported its own latency, the other has not: the
    // unmeasured one answers `None`, never zero.
    shared.mirrors[0]
        .stream_latency_ms
        .store(150, Ordering::Relaxed);

    let route = route_of(&shared).expect("an engine with copies is a route");

    assert_eq!(route.pid, 1);
    assert_eq!(route.generation, 3);
    assert_eq!(route.device_ids, vec!["primary", "device-0", "device-40"]);
    assert_eq!(route.latency_ms.len(), route.device_ids.len());
    // The primary heads both lists and is the one entry this engine cannot
    // answer for: Windows plays it, so there is no stream of ours to ask.
    assert_eq!(route.latency_ms[0], None);
    assert_eq!(route.latency_ms[1], Some(250));
    assert_eq!(route.latency_ms[2], None);
}

#[test]
fn an_engine_that_lost_every_copy_is_reported_on_the_primary_alone() {
    // The hold exists so that a stopped-looking route does not take the
    // still-playing primary off the board — and the report is what the board
    // is rebuilt from. An engine that vanished from this list would take its
    // badge with it and leave the per-app assignment unreachable, which is
    // the dead end the release lifecycle exists to close. The failed copies
    // are not named: a device producing nothing has no dot and no pulse.
    let shared = engine(&[0, 40], 0, true);
    for mirror in &shared.mirrors {
        mirror.enabled.store(false, Ordering::Relaxed);
    }

    let route = route_of(&shared).expect("a held engine is still a route");

    assert_eq!(route.device_ids, vec!["primary"]);
    assert_eq!(route.latency_ms, vec![None]);
}

#[test]
fn a_still_served_copy_keeps_its_place_after_a_sibling_failed() {
    // One copy errored, the other is fine: the route is primary + the living
    // copy, and the failed one is gone from the middle of the list rather
    // than reported as a device that produces nothing.
    let shared = engine(&[0, 40], 0, true);
    shared.mirrors[0].enabled.store(false, Ordering::Relaxed);

    let route = route_of(&shared).expect("one copy left standing is a route");

    assert_eq!(route.device_ids, vec!["primary", "device-40"]);
    assert_eq!(route.latency_ms.len(), 2);
}

#[test]
fn an_engine_that_only_carries_a_tap_is_no_route() {
    let shared = tap_engine();

    assert!(route_of(&shared).is_none());
}
