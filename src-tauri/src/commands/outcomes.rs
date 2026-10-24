//! What a command leaves to report, and the two readers of a release's answer.
//!
//! These shapes are declared once here because more than one path reports with
//! them: `StopOutcome` is what a stop answers with and what a route's own rollback
//! falls back on, `FeedOutcome` and `ResetOutcome` belong to the feed and the reset
//! paths, `AlignOutcome` to the level alignment. The root re-exports them so a
//! submodule names them as `super::Xxx`.
//!
//! `FeedOutcome`'s `reason` and `ResetOutcome`'s parallel arrays are the same
//! bargain as everywhere else on this wire: a report that cannot say which of two
//! things happened is a report the UI has to guess at, so the enum is spelled out
//! and `still_pinned_devices` keeps the order and length of `still_pinned`.
//!
//! [`superseded_release`] and [`released_cleanly`] exist because an endpoint
//! release can answer with something other than "handed back", and a caller must
//! not read either of those two as if it were: an empty answer means the walk never
//! asked about that process, and a superseded one means a newer write owns the slot
//! — falling back on either would forget a pin that is still standing, or write the
//! default device over somebody else's route.

use log::warn;
use serde::Serialize;

use crate::audio;
use crate::audio::routing::ReleaseOutcome;

/// What a stop left behind.
#[derive(Debug, Serialize)]
pub struct StopOutcome {
    /// True when the program follows the system default again — the assignment
    /// this app wrote is gone, so a later change of the default device moves it.
    pub released: bool,
    /// Endpoint the program is still pinned to, when the release did not take.
    /// The UI warns about this instead of claiming the route is fully undone.
    /// Which of the two failures left it pinned is the `sibling_held` flag's
    /// business, not something the UI may infer from the presence of a device.
    pub pinned_device: Option<String>,
    /// True when `released` is false because a sibling process of the same
    /// executable still routes the program: the assignment is owned by that live
    /// route and will go back when the sibling stops, not stuck. The stop path
    /// also yields `released: false` when Windows refused to clear the pin (and
    /// the program was pointed at the default), and when a *newer* write claimed
    /// the program's slot before this stop's release reached it — there the slot
    /// was deliberately left to that newer writer, so neither the fallback write
    /// nor the `sibling_held` flag describes it. The UI must not infer which it
    /// got — reporting a refused release as a sibling route would drop the device
    /// name and hide a real failure.
    pub sibling_held: bool,
}

/// Whether a release walk answered that it never asked the service at all,
/// because a newer write claimed that program's slot first.
///
/// Worth pulling out because it is the one outcome a caller must *not* treat as a
/// release that merely failed to confirm: the fallback paths below exist to point
/// the program somewhere sensible when Windows would not let go, and writing the
/// default device over a slot that a newer route just took is not sensible — it is
/// the race this ordering exists to close, arriving by way of the rollback.
pub(super) fn superseded_release(outcomes: &[(u32, ReleaseOutcome)]) -> bool {
    outcomes
        .iter()
        .any(|(_, outcome)| *outcome == ReleaseOutcome::Superseded)
}

/// What a sweep of left-over assignments found.
#[derive(Debug, Serialize)]
pub struct ResetOutcome {
    /// Programs whose assignment was released.
    pub released: usize,
    /// Executable names still carrying an assignment the service would not drop.
    pub still_pinned: Vec<String>,
    /// One entry per `still_pinned`, same order and length: the endpoint id
    /// Windows still holds for it, or `null` when the audio service would not
    /// answer for that process so no device can be named. A stop reports this as
    /// `pinned_device`; the reset owed the same "which device stays fixed" answer
    /// and did not have it.
    pub still_pinned_devices: Vec<Option<String>>,
}

/// What one run of the level alignment did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignOutcome {
    /// Programs whose level was set, as `(exe_name, percent)`.
    pub aligned: Vec<(String, u32)>,
    /// Programs that were routed but left exactly as they were, because nothing
    /// was playing in them to measure. Aligning against silence would be
    /// aligning against nothing.
    pub left_alone: Vec<String>,
    /// How many routed programs had a level to align with — a live reading that
    /// was not silence.
    ///
    /// Reported because an empty `aligned` has two different reasons behind it:
    /// nothing was playing, or only one program was, and one program cannot be
    /// aligned against itself. The caller has to be able to say which, and a
    /// program sitting in a quiet passage is not "playing" for that purpose —
    /// counting the live readings instead would tell a user who can hear sound
    /// that none of their programs made any.
    pub playing: usize,
}

/// What one feed change actually did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedOutcome {
    /// True when the wire is in place and sound can move.
    pub delivered: bool,
    /// Why it could not be delivered, when it could not: `no_carrier` — no
    /// loopback pair is configured yet, so the rule is recorded and waits.
    pub reason: Option<FeedBlockReason>,
}

/// Why a recorded feed is not moving sound.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedBlockReason {
    NoCarrier,
}

/// Whether a release attempt came back clean for every endpoint it was asked
/// about, naming in the log the half that failed.
///
/// An answer of *nothing* is not a clean release: the walk skips a process it
/// will not speak for, and a caller that read an empty list as success would
/// forget its pin while the program stayed fixed to the endpoint — with the board
/// already moved on, nothing later would come back for it.
pub(super) fn released_cleanly(
    release: Result<Vec<(u32, ReleaseOutcome)>, audio::AudioError>,
    which: &str,
) -> bool {
    match release {
        Ok(outcomes) => {
            if outcomes.is_empty() {
                warn!("the {which} endpoint release answered nothing for the process it was asked about");
                return false;
            }
            let stuck: Vec<String> = outcomes
                .iter()
                .filter(|(_, outcome)| *outcome != ReleaseOutcome::Released)
                .map(|(_, outcome)| match outcome {
                    ReleaseOutcome::StillPinned(device) => format!("still fixed to {device}"),
                    // Answered `false`, which is the whole requirement here: the pin
                    // stays on the book and the name goes into what the user is told,
                    // because the endpoint was not handed back by this run.
                    ReleaseOutcome::Superseded => {
                        "a newer write took the slot before this release".to_string()
                    }
                    _ => "not confirmed clear".to_string(),
                })
                .collect();
            if stuck.is_empty() {
                return true;
            }
            warn!(
                "the {which} endpoint was not handed back: {}",
                stuck.join(", ")
            );
            false
        }
        Err(e) => {
            warn!("could not ask for the {which} endpoint to be released: {e}");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A release that answers *nothing* is not a release that came back clean: the
    /// walk drops a process it will not speak for, and the caller that read an
    /// empty list as success would forget the pin while the program stayed fixed to
    /// the carrier — the board having already dropped the wire, nothing later would
    /// come back for it.
    #[test]
    fn an_empty_answer_is_not_a_clean_release() {
        assert!(
            !released_cleanly(Ok(Vec::new()), "feed source"),
            "no verdict at all is not a verdict of released"
        );
        assert!(
            released_cleanly(Ok(vec![(7, ReleaseOutcome::Released)]), "feed source"),
            "one process answered, handed back"
        );
        assert!(
            !released_cleanly(Ok(vec![(7, ReleaseOutcome::Unknown)]), "feed target"),
            "a refusal is reported, not swallowed"
        );
        assert!(
            !released_cleanly(
                Ok(vec![(
                    7,
                    ReleaseOutcome::StillPinned("{0.0.0.00000000}.{a}".to_string())
                )]),
                "feed target"
            ),
            "and so is a named device it would not give up"
        );
        assert!(
            !released_cleanly(
                Err(audio::AudioError::Api("the service is gone".to_string())),
                "feed source"
            ),
            "a walk that could not be asked at all is not a clean one"
        );
    }

    /// A release that was superseded is neither a hand-back nor a release the
    /// service refused, and every caller has to be able to tell it apart from both:
    /// read as a hand-back it forgets a pin that is still standing, read as a
    /// refusal it writes the default device over the newer route that won the slot.
    #[test]
    fn a_superseded_release_is_neither_a_hand_back_nor_a_refusal_to_fall_back_on() {
        let superseded = vec![(7, ReleaseOutcome::Superseded)];
        assert!(
            superseded_release(&superseded),
            "the stop and the rollback both sort on this"
        );
        assert!(
            !released_cleanly(Ok(superseded.clone()), "feed source"),
            "and it is never read as clean, so a pin is never forgotten behind it"
        );
        assert!(
            !superseded_release(&[(7, ReleaseOutcome::Released)]),
            "a release that did run is not this"
        );
        assert!(
            !superseded_release(&[(7, ReleaseOutcome::StillPinned("device".to_string()))]),
            "and neither is one the service would not answer for — that one keeps its fallback"
        );
        assert!(
            !superseded_release(&[]),
            "an empty answer is the sweep's own problem, not a superseded one"
        );
    }
}
