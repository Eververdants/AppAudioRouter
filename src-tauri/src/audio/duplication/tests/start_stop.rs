//! The in-flight-start handshake: a stop waits for a start that has not landed,
//! and a stop that stopped waiting refuses that start the seat — per pid, and only
//! for the starts it actually waited on.

use std::sync::Arc;
use std::time::Duration;

use crate::audio::duplication::registry::StartRegistry;
use crate::audio::duplication::START_SETTLE_TIMEOUT;

#[test]
fn a_stop_that_lands_while_a_start_is_in_flight_waits_for_it() {
    // The resurrection bug: `stop` removed nothing while a start walked its
    // slow COM path, and the start's later insertion brought back an engine
    // whose route was already gone. The registry is what closes that window
    // — a waiter must not pass until the start has settled.
    let registry = Arc::new(StartRegistry::default());
    let first = registry.begin(7);
    let second = registry.begin(7); // two overlapping starts: one clear is not enough
    let (tx, rx) = std::sync::mpsc::channel();
    let waiting = {
        let registry = Arc::clone(&registry);
        std::thread::spawn(move || {
            registry.wait_for_quiet(7, START_SETTLE_TIMEOUT);
            let _ = tx.send(());
        })
    };
    assert!(
        rx.recv_timeout(Duration::from_millis(200)).is_err(),
        "the stop passed while a start was still in flight"
    );
    registry.clear(7);
    assert!(
        rx.recv_timeout(Duration::from_millis(200)).is_err(),
        "the stop passed while the second start was still in flight"
    );
    registry.clear(7);
    assert!(
        rx.recv_timeout(Duration::from_secs(1)).is_ok(),
        "the stop never woke when both starts had settled"
    );
    waiting.join().unwrap();
    // Neither start was refused for a stop it did not have to wait on.
    assert!(!registry.should_withdraw(7, first));
    assert!(!registry.should_withdraw(7, second));
}

#[test]
fn a_stop_that_gives_up_refuses_the_seat_to_the_starts_it_waited_on() {
    // The bounded half of the handshake. A start whose COM path never answers
    // must not be able to hold `stop` — and so the stop's own command, and
    // the endpoint release behind it — open forever. What the stop leaves
    // behind instead is a ticket: the in-flight starts withdraw at their
    // insertion, and the eviction that follows the ticket takes anything
    // that landed first.
    let registry = StartRegistry::default();
    let in_flight = registry.begin(7);
    assert!(!registry.wait_for_quiet(7, Duration::ZERO));
    assert!(
        registry.should_withdraw(7, in_flight),
        "the start the stop gave up on was left free to seat"
    );
    // A route asked for after the stop is the next word, not the stopped
    // one: it began above the boundary and keeps its seat.
    let later = registry.begin(7);
    assert!(
        !registry.should_withdraw(7, later),
        "a start begun after the ticket was refused for a stop it never raced"
    );
    registry.clear(7);
    registry.clear(7);
    // And the refusal dies with the starts it was written for: once the
    // count drains there is nothing left to withdraw, forever.
    assert!(registry.wait_for_quiet(7, Duration::ZERO));
    let next = registry.begin(7);
    assert!(!registry.should_withdraw(7, next));
    registry.clear(7);
}

#[test]
fn a_stop_only_refuses_the_program_it_was_asked_about() {
    // The ticket is per pid: a stop that gave up on one program must not be
    // what makes another one's route play on nothing.
    let registry = StartRegistry::default();
    let other = registry.begin(9);
    let waited_on = registry.begin(7);
    assert!(!registry.wait_for_quiet(7, Duration::ZERO));
    assert!(registry.should_withdraw(7, waited_on));
    assert!(!registry.should_withdraw(9, other));
    registry.clear(7);
    registry.clear(9);
}

#[test]
fn the_shutdown_sweep_refuses_every_start_still_in_flight() {
    // `take_pending_session_volume_restores` cannot wait on anything: the app
    // is closing. Whatever it does not wait for has to be refused instead, or
    // an engine seats after the last restore was collected and keeps the
    // program at the route's loudness.
    let registry = StartRegistry::default();
    let first = registry.begin(7);
    let second = registry.begin(8);
    registry.begin(8);
    assert_eq!(
        registry.ticket_all(),
        2,
        "the sweep counted programs by start instead of by pid"
    );
    assert!(registry.should_withdraw(7, first));
    assert!(registry.should_withdraw(8, second));
    for pid in [7, 8] {
        registry.clear(pid);
        registry.clear(pid);
    }
    assert!(registry.wait_for_quiet(7, Duration::ZERO));
    assert!(registry.wait_for_quiet(8, Duration::ZERO));
}
