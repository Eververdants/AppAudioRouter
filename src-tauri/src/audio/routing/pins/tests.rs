use super::*;

use crate::audio::routing::guard::process_name_for_guard;

/// A program handed back to the default is not a live route: the settings
/// reset has to be able to clear that assignment, while only a route keeps
/// one on purpose.
#[test]
fn a_handed_back_program_is_not_a_live_route() {
    let pins = PinnedRoutes::new();
    // `is_routed` also asks whether the entry's process still lives, so the
    // route entry needs a pid that really does: the test process itself.
    let live = std::process::id();
    pins.mark(live, "game.exe", "device-a");
    pins.mark_returned(2, "browser.exe", "device-b");
    pins.mark(3, "quiet.exe", "device-c");
    pins.mark_abandoned(3);

    assert_eq!(pins.routed_pids(), vec![live]);
    assert!(pins.is_routed(live));
    // Both ways an entry can stop being a route answer `no` here, and both
    // still ride the shutdown release.
    assert!(!pins.is_routed(2));
    assert!(!pins.is_routed(3));
    // A route entry whose pid no process answers any more is not a live
    // route either — the pid-recycled stranger a feed must not be suspended
    // for. Its bookkeeping still rides the shutdown release.
    pins.mark(u32::MAX, "gone.exe", "device-d");
    assert!(!pins.is_routed(u32::MAX));

    pins.forget(live);
    // The one thing `routed_pids` is for: a kind answer, whatever the process
    // does now. The sweep reads this list to decide whether the entry it
    // drops was a route whose render slot came free — the pid it asks about
    // has no session by then, so `is_routed` could only ever answer `no`.
    assert_eq!(pins.routed_pids(), vec![u32::MAX]);
    assert!(
        !pins.is_routed(u32::MAX),
        "and it is not read as a live route"
    );
    let mut released = pins.take_all();
    released.sort();
    assert_eq!(released, vec![2, 3, u32::MAX]);
}

/// Put one entry on the book the way `mark` cannot: with no creation time,
/// which is what a process that could not be opened when it was written
/// leaves behind.
fn insert_without_a_witness(pins: &PinnedRoutes, pid: u32, exe_name: &str, kind: PinKind) {
    let mut inner = pins.inner.lock().unwrap();
    inner.insert(
        pid,
        PinnedRoute {
            exe_name: exe_name.to_string(),
            device_id: "device".to_string(),
            kind,
            creation_time: 0,
        },
    );
}

/// An entry written without a creation time has no exact witness, and
/// `process_is_running` then judges only the exit code: read that way, *any*
/// live process holding the pid is credited with the route — which is the
/// recycling the witness exists to prevent, arriving by a different road. It
/// must be credited only to the program the entry names, because the
/// assignment it speaks for is stored per executable.
#[test]
fn an_entry_without_a_witness_is_credited_only_to_the_program_it_names() {
    let pins = PinnedRoutes::new();
    let live = std::process::id();
    let own_name = process_name_for_guard(live).expect("the test process can name itself");

    insert_without_a_witness(&pins, live, &own_name, PinKind::Route);
    assert!(
        pins.is_routed(live),
        "the same program running under that pid still holds the assignment"
    );

    // A different program that now answers to the pid is a stranger, however
    // alive — and it must not speak for the executable's reset either.
    insert_without_a_witness(&pins, live, "someone-else.exe", PinKind::Route);
    assert!(!pins.is_routed(live), "a recycled pid is not our route");
    assert!(!pins.exe_routed_elsewhere(999_999, "someone-else.exe"));

    // An entry that cannot even say whose it is has no witness at all.
    insert_without_a_witness(&pins, live, "", PinKind::Route);
    assert!(!pins.is_routed(live));
}

/// A feed that has to be put back is rebuilt **through** the pid its pin
/// names. Offering a pin whose process is gone would start an engine
/// capturing whatever process holds that pid now — an unrelated programme
/// sent into someone's microphone — so the list a resume walks carries only
/// pins that still speak for a live process. The pin itself stays on the
/// book: the sweep forgets it and exit cleanup still walks it.
#[test]
fn a_feed_pin_of_a_gone_process_is_not_offered_for_resume() {
    let pins = PinnedRoutes::new();
    let live = std::process::id();
    pins.mark_feed(live, "sender.exe");
    pins.mark_feed(u32::MAX, "gone.exe");

    let listed = pins.feed_source_pins();
    assert!(
        listed.contains(&(live, "sender.exe".to_string())),
        "a pin whose process runs is offered"
    );
    assert!(
        !listed.iter().any(|(pid, _)| *pid == u32::MAX),
        "a pin whose process is gone is not"
    );
    assert!(
        pins.take_all().contains(&u32::MAX),
        "and it is still on the book to be handed back"
    );
}

/// A route that died with its process stops holding the executable's
/// assignment: the sibling question is what keeps `stop_route` from releasing
/// a live route's endpoint and what makes a feed decide to wait, and an entry
/// that outlives its process would have both wait for nothing.
#[test]
fn a_dead_sibling_does_not_hold_the_programs_assignment() {
    let pins = PinnedRoutes::new();
    let live = std::process::id();
    pins.mark(live, "browser.exe", "device-a");
    // A live route of the same executable holds it, whatever the spelling
    // the two callers happen to have.
    assert!(pins.exe_routed_elsewhere(999_999, "browser.exe"));
    assert!(pins.exe_routed_elsewhere(999_999, "BROWSER.EXE"));
    // The entry's own process is not a sibling of itself.
    assert!(!pins.exe_routed_elsewhere(live, "browser.exe"));

    // A dead one answers no, while its bookkeeping still rides the sweep and
    // the shutdown release.
    pins.mark(u32::MAX, "game.exe", "device-b");
    assert!(!pins.exe_routed_elsewhere(1234, "game.exe"));
    assert!(pins.routed_pids().contains(&u32::MAX));
    assert!(pins.take_all().contains(&u32::MAX));
}

/// A chain — `A` into `B`, `B` into `C` — writes `B` on both flows, and
/// forgetting one half must not lose the other. A pin that goes missing is a
/// half nothing can hand back any more: the programme keeps receiving or
/// sending after the board says the feed was removed, which reads as the
/// removal having worked.
#[test]
fn one_program_holds_both_feed_halves() {
    let pins = PinnedRoutes::new();
    pins.mark_feed_capture(20, "b.exe");
    pins.mark_feed(20, "b.exe");

    assert_eq!(
        pins.feed_capture_of(20).as_deref(),
        Some("b.exe"),
        "the capture half outlived having the render half pinned after it"
    );
    assert_eq!(pins.feed_source_of(20).as_deref(), Some("b.exe"));

    pins.forget_feed_source(20);
    assert!(pins.feed_source_of(20).is_none());
    assert!(pins.feed_capture_of(20).is_some());

    // Both books feed the same shutdown list, and a pid in both appears once.
    pins.mark_feed(21, "c.exe");
    let mut all = pins.take_all();
    all.sort();
    assert_eq!(all, vec![20, 21]);
}
