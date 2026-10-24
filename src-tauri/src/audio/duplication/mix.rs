//! The group arithmetic: what one engine's device set adds up to.
//!
//! Three references and the numbers built from them. [`group_min_delay_ms`] — the
//! earliest device of the group is the only one that can stay where it is, so every
//! delay is realized as the difference above it ([`target_frames`]).
//! [`group_max_volume`] — the loudest *copy* is the reference, and a share may only
//! ever attenuate ([`volume_gain`]). [`session_compensation`] — the tap sits behind
//! the program's session volume, so the copies divide it back out and the primary's
//! loudness stays the one lever that moves the primary path alone.
//!
//! A feed tap is in none of it: it is a wire into another program, not somewhere a
//! person listens, so it carries no share, no delay, only the base pipeline, and it
//! never appears in [`total_latency_ms`]’s route report.

use std::sync::atomic::Ordering;

use super::mirror::MirrorChannel;
use super::shared::EngineShared;

/// Delay of the earliest device of the group, in milliseconds.
///
/// Every device carries its own delay measured against the app's audio as
/// captured, but only the earliest one can stay where it is: the OS plays the
/// primary device natively and software delay can only be added, never removed.
/// That earliest device is therefore the group's reference and every other
/// device is held back by the difference (see `target_frames`). The route is
/// ordered so the primary is normally the minimum, but a delay lowered while
/// the engine runs can briefly move the reference to a mirror — which simply
/// shifts the group instead of glitching.
pub(super) fn group_min_delay_ms(shared: &EngineShared) -> i32 {
    shared
        .mirrors
        .iter()
        .filter(|m| !m.feed_tap && m.enabled.load(Ordering::Relaxed))
        .map(|m| m.delay_ms.load(Ordering::Relaxed))
        .chain(std::iter::once(
            shared.primary_delay_ms.load(Ordering::Relaxed),
        ))
        .min()
        .unwrap_or(0)
}

/// Volume of the loudest *copy* in the group, which is the level every other
/// mirror is scaled against.
///
/// Software gain attenuates but never boosts, so the loudest mirror stays
/// where the app put it and the rest are brought down towards it. The primary
/// is deliberately not in the reference: its loudness is the program's session
/// volume (`session_volume_percent`) — a property of the program, and the one
/// thing about the primary that *can* move — while a mirror's share stays a
/// property of the device. Mixing the two into one reference would make every
/// mirror chase a number a session-volume change moves without any mirror
/// click. Mirrors that failed to open are ignored, exactly as they are for
/// delays. Floored at 1 so an all-zero group stays a valid (silent) division.
pub(super) fn group_max_volume(shared: &EngineShared) -> u32 {
    shared
        .mirrors
        .iter()
        .filter(|m| !m.feed_tap && m.enabled.load(Ordering::Relaxed))
        .map(|m| m.volume_percent.load(Ordering::Relaxed))
        .max()
        .unwrap_or(100)
        .max(1)
}

/// Gain that undoes the program's session volume on the copies.
///
/// The loopback tap sits behind the session volume, so lowering it lowers what
/// the mirrors receive too — and with it everything the copies would play.
/// Dividing their gain by the same factor puts the copies back exactly where
/// they were, which is what makes the primary's volume control move the
/// primary path alone: in a mirror's arithmetic the session volume cancels,
/// and in the primary's path it is the whole change. The percentage is
/// floored at [`crate::config::PRIMARY_VOLUME_MIN_PERCENT`], both because the
/// stored value is clamped there and so an out-of-band zero can never divide.
pub(super) fn session_compensation(shared: &EngineShared) -> f32 {
    let percent = shared
        .session_volume_percent
        .load(Ordering::Relaxed)
        .max(crate::config::PRIMARY_VOLUME_MIN_PERCENT) as f32;
    100.0 / percent
}

/// Gain to apply to `mirror`'s frames: its own share of the group's loudest
/// device, i.e. 1.0 when it is the loudest one (or the only one left).
pub(super) fn volume_gain(shared: &EngineShared, mirror: &MirrorChannel) -> f32 {
    // A tap is a wire into another programme, not a place somebody listens:
    // there is no device share to honour and no group to balance against, so it
    // carries the audio exactly as the programme produced it.
    if mirror.feed_tap {
        return 1.0;
    }
    let own = mirror.volume_percent.load(Ordering::Relaxed);
    // The group max re-reads every share, so a volume change that lands
    // between the two loads can hand back a max below `own` — a gain above
    // 1.0, one chunk at clip level, from an arithmetic that may only ever
    // attenuate. `own` is part of that group, so a legit max is never smaller;
    // the floor says so.
    own as f32 / group_max_volume(shared).max(own) as f32
}

/// Gain for the program's own audio, from its persisted level.
///
/// This is the only gain in this module that may exceed 1.0. A device's share of
/// its group can only attenuate, because that device has a hardware volume above
/// the software one that can be turned up; a program's audio has nothing above
/// it, so raising a quiet program to the level of its neighbours means
/// amplifying it. See `SOURCE_VOLUME_MAX` for the ceiling and why it is there.
pub(super) fn source_gain(shared: &EngineShared) -> f32 {
    shared.source_volume_percent.load(Ordering::Relaxed) as f32 / 100.0
}

/// Frames this mirror keeps buffered between the capture tap and playback: the
/// base latency plus how far its own delay sits above the earliest device in
/// the group. All mirrors holding their own target means they all play the same
/// capture position at the same time, offset by exactly the delays that were
/// configured for them.
pub(super) fn target_frames(shared: &EngineShared, mirror: &MirrorChannel) -> usize {
    // The feed tap is not part of the device group: it is held only by the base
    // pipeline, so the other programme records the programme's audio with the
    // engine's own latency and none of the alignment this route's devices asked
    // for. Its delay field is neutral by construction (see `start`).
    if mirror.feed_tap {
        return shared.latency_frames;
    }
    if !shared.sync_delays.load(Ordering::Relaxed) {
        return shared.latency_frames;
    }
    let offset_ms = mirror.delay_ms.load(Ordering::Relaxed) - group_min_delay_ms(shared);
    let offset_frames = shared.sample_rate as usize * offset_ms.max(0) as usize / 1000;
    shared.latency_frames + offset_frames
}

/// The software-side latency `mirror` is playing at, in milliseconds: the
/// pipeline it holds between the capture tap and the endpoint, which is the
/// engine's base latency plus this device's delay compensation (see
/// `target_frames`), plus what the endpoint reports as its own.
///
/// `None` when the endpoint never reported a latency, so a device that was
/// never measured is not drawn with a confident-looking number. Whatever a
/// hardware codec or a Bluetooth link adds on top of this is not observable
/// from user mode and is deliberately not guessed at.
pub(super) fn total_latency_ms(shared: &EngineShared, mirror: &MirrorChannel) -> Option<u32> {
    let stream_ms = mirror.stream_latency_ms.load(Ordering::Relaxed);
    if stream_ms == 0 {
        return None;
    }
    let rate = shared.sample_rate.max(1) as u64;
    let pipeline_ms = (target_frames(shared, mirror) as u64 * 1000 / rate) as u32;
    Some(pipeline_ms.saturating_add(stream_ms))
}
