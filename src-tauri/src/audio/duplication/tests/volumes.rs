//! The two volume axes apart: a copy's share of the loudest *enabled* copy (never
//! a boost), the program's own level (allowed above unity), and the session volume
//! the copies divide back out.

use std::sync::atomic::Ordering;

use crate::audio::duplication::mix::{
    group_max_volume, session_compensation, source_gain, volume_gain,
};

use super::builders::{engine, engine_with_volumes};

#[test]
fn the_loudest_copy_is_the_reference_volume() {
    let shared = engine_with_volumes(&[50, 100], 80);
    assert_eq!(group_max_volume(&shared), 100);
    // The loudest copy plays as the app produced it; the quieter one is
    // brought down to half.
    assert_eq!(volume_gain(&shared, &shared.mirrors[0]), 0.5);
    assert_eq!(volume_gain(&shared, &shared.mirrors[1]), 1.0);
}

#[test]
fn the_session_volume_is_not_in_the_copies_reference() {
    // The primary's loudness is the program's session volume — a property
    // of the program, not of a device — so it stays out of the reference
    // the mirrors are measured against. A session-volume change must not
    // move a single mirror's share gain.
    let shared = engine_with_volumes(&[25, 50], 100);
    assert_eq!(group_max_volume(&shared), 50);
    assert_eq!(volume_gain(&shared, &shared.mirrors[0]), 0.5);
    assert_eq!(volume_gain(&shared, &shared.mirrors[1]), 1.0);
}

#[test]
fn the_copies_are_compensated_for_the_session_volume() {
    // The capture sits behind the session volume, so a mirror's total gain
    // divides it back out: at a session volume of 50 the captured stream
    // is half of what the program produced, and the copies play at exactly
    // the share the device asked for — 100 here, i.e. untouched.
    let shared = engine_with_volumes(&[100], 50);
    let mirror = &shared.mirrors[0];
    assert_eq!(session_compensation(&shared), 2.0);
    assert_eq!(
        source_gain(&shared) * volume_gain(&shared, mirror) * session_compensation(&shared),
        2.0
    );

    // And the floor keeps an out-of-band zero from dividing.
    shared.session_volume_percent.store(0, Ordering::Relaxed);
    assert_eq!(
        source_gain(&shared) * volume_gain(&shared, mirror) * session_compensation(&shared),
        20.0
    );
}

#[test]
fn an_all_muted_group_stays_silent_instead_of_dividing_by_zero() {
    let shared = engine_with_volumes(&[0, 0], 0);
    assert_eq!(group_max_volume(&shared), 1);
    assert_eq!(volume_gain(&shared, &shared.mirrors[0]), 0.0);
}

#[test]
fn disabled_mirrors_do_not_raise_the_copies_reference_volume() {
    let shared = engine_with_volumes(&[20, 100], 50);
    shared.mirrors[1].enabled.store(false, Ordering::Relaxed);
    assert_eq!(group_max_volume(&shared), 20);
    assert_eq!(volume_gain(&shared, &shared.mirrors[0]), 1.0);
}

#[test]
fn a_share_above_the_reference_never_boosts() {
    // The mirror's own share and the group max are two separate reads, and
    // a volume change — or a mirror going out of service — between them
    // can hand back a max below `own`. Attenuation is the only thing this
    // gain may do, so the read floors at the mirror's own share rather
    // than letting one chunk through at a boost.
    let shared = engine_with_volumes(&[100, 20], 80);
    shared.mirrors[0].enabled.store(false, Ordering::Relaxed);
    // The loudest share is no longer counted in the reference...
    assert_eq!(group_max_volume(&shared), 20);
    // ...but its own gain still never boosts.
    assert_eq!(volume_gain(&shared, &shared.mirrors[0]), 1.0);
}

#[test]
fn a_programs_own_level_can_amplify_it() {
    // One mirror, both volumes neutral, so the device share is exactly 1.0
    // and the product below is the program's level alone.
    let eng = engine(&[0], 0, true);
    let mirror = &eng.mirrors[0];
    assert_eq!(source_gain(&eng) * volume_gain(&eng, mirror), 1.0);

    // A program quieter than its neighbours is brought up to them, and what
    // `apply_gain` is handed is then above unity — which is the only reason
    // the shortcut there may not test `>=`.
    eng.source_volume_percent.store(250, Ordering::Relaxed);
    assert_eq!(source_gain(&eng), 2.5);
    assert_eq!(source_gain(&eng) * volume_gain(&eng, mirror), 2.5);
}
