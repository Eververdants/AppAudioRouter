//! The order the writes to one program's endpoint slot arrive in.
//!
//! Several writers can be in flight for the same slot at the same moment — a
//! manual Apply, a sweep release, a remembered restore — and whichever reached
//! the audio service last used to win, including when it was the one asked for
//! first. The clock here decides that instead: the newest ask for a slot
//! writes, an older one is refused before any slot call, so a losing writer
//! never leaves a half-written assignment behind. The numbering and the gate
//! share one mutex on purpose; the docs on [`slot_clock`] and [`hold_slot`]
//! carry the rest of the argument, including the leaf-lock rule.
//!
//! A slot is addressed by executable and by data flow, so the render half and
//! the capture half of one program are ordered apart — the same split that
//! gives [`super::pins::PinnedRoutes`] its separate books.

use crate::audio::AudioError;

use super::guard::process_name_for_guard;
use super::policy::E_CAPTURE;

// ---------------------------------------------------------------------------
// Write order
// ---------------------------------------------------------------------------

/// One program's endpoint slot, addressed the way the audio service addresses
/// it: by executable, and by which of the two data flows the write means.
///
/// The two halves carry one counter each because they *are* two slots — a
/// program can be routed to a device and receive a feed at the same time, and a
/// newer ask on the capture half has no business refusing a write to the render
/// half. Same reasoning that gives `PinnedRoutes` two feed books beside the
/// route book, and it is why the release paths name the flow they mean.
pub(super) type SlotKey = (String, i32);

/// The clock, and the lock that keeps a gated write alone with its slot.
pub(super) type SlotClock = std::sync::Mutex<std::collections::HashMap<SlotKey, u64>>;

/// A hold on the clock taken at the gate.
pub(super) type SlotHoldGuard<'a> =
    std::sync::MutexGuard<'a, std::collections::HashMap<SlotKey, u64>>;

/// Where one write stands in the order of its slot.
///
/// Frontend-side queueing was the other shape on the table and is deliberately
/// not this one: a queue would make Apply wait behind whatever the sweep had
/// already lined up, and the ticket a page hands out restarts with the page.
/// The clock is therefore Rust's own, and nothing about it crosses the wire.
#[derive(Clone)]
pub(super) struct SlotClaim {
    pub(super) key: SlotKey,
    pub(super) ticket: u64,
}

/// The clock every writer of a slot shares.
///
/// One mutex does both jobs — handing out tickets and gating the write — on
/// purpose: with a single lock, a ticket can never be handed out while another
/// writer is inside the slot, so a writer that passes the gate is certain to
/// land, and a writer that loses it has not touched the slot at all. That is the
/// whole window: the reader of an older ticket used to be free to arrive last.
///
/// **Leaf lock.** Nothing in this crate may take it while holding a
/// `PinnedRoutes` book lock, and nothing may take a book lock while holding it.
/// The books are written by callers once the slot call has returned, and no
/// system call happens under either (`exe_routed_elsewhere` spells out the same
/// rule for the books). Only the slot calls themselves run under this lock —
/// the policy activation, which is the slow part, stays outside of it.
fn slot_clock() -> &'static SlotClock {
    static CLOCK: std::sync::OnceLock<SlotClock> = std::sync::OnceLock::new();
    CLOCK.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Issue the next ticket for one slot. Kept apart from the lock so the numbering
/// can be tested.
fn ticket_for(clock: &mut std::collections::HashMap<SlotKey, u64>, key: &SlotKey) -> u64 {
    let issued = clock.entry(key.clone()).or_insert(0);
    *issued += 1;
    *issued
}

/// Whether a claim still stands at the front of its own slot.
///
/// The rule, so it can be said out loud rather than inferred from an `if`: the
/// newest claim wins, **equal counts as newest**, and an older one loses. A claim
/// nothing else has touched its slot since is the writer that has to be allowed
/// through, or the first route on a quiet machine would refuse itself. A claim
/// *ahead* of the clock can only mean the clock forgot this slot, which is the
/// same situation, so it goes through too. Nothing else is consulted: a stamp
/// from another executable, or from the other half of the same program, says
/// nothing about this slot.
fn claim_is_newest(clock: &std::collections::HashMap<SlotKey, u64>, claim: &SlotClaim) -> bool {
    clock
        .get(&claim.key)
        .map(|issued| *issued <= claim.ticket)
        // A slot nobody has claimed since this write did — nothing to lose to.
        .unwrap_or(true)
}

/// Which slot the write path addresses: the program `pid` runs, and the half of
/// its assignment the write means. `None` when the executable cannot be named.
fn slot_key_for(pid: u32, data_flow: i32) -> Option<SlotKey> {
    let exe_name = process_name_for_guard(pid)?;
    Some((exe_name.to_ascii_lowercase(), data_flow))
}

/// Take the next ticket for a slot the caller has already resolved.
fn claim_slot(key: &SlotKey) -> SlotClaim {
    let mut clock = slot_clock().lock().unwrap_or_else(|e| e.into_inner());
    let ticket = ticket_for(&mut clock, key);
    SlotClaim {
        key: key.clone(),
        ticket,
    }
}

/// Take this write's place in the order of the program `pid` runs, on the
/// `data_flow` half of its slot.
///
/// `None` when the executable cannot be named, and that hole is on purpose: the
/// writers that reach this with an unnameable process are releases of a program
/// that has already gone away, and refusing to hand an assignment back is the
/// exact failure 2.1.1 exists to close. A *write* never takes it — an unreadable
/// name is what `routing_refusal` refuses the route over, before this is asked.
pub(super) fn claim_endpoint_slot(pid: u32, data_flow: i32) -> Option<SlotClaim> {
    slot_key_for(pid, data_flow).map(|key| claim_slot(&key))
}

/// The claim for `pid`'s slot, taken from `held` when this walk already took one.
///
/// Two processes of one program address the same slot, and one release walk speaks
/// for that slot once: handing the second pid a second ticket would make the *first*
/// pid's release the older claim and refuse it, so a walk would supersede itself and
/// leave one of the two programs pinned while reporting both handed back.
pub(super) fn claim_walked_slot(
    pid: u32,
    data_flow: i32,
    held: &mut std::collections::HashMap<SlotKey, Option<SlotClaim>>,
) -> Option<SlotClaim> {
    let key = slot_key_for(pid, data_flow)?;
    if let Some(existing) = held.get(&key) {
        return existing.clone();
    }
    let claim = Some(claim_slot(&key));
    held.insert(key, claim.clone());
    claim
}

/// A write's hold on its slot, or the reason it may not have the slot.
pub(super) enum SlotHold<'a> {
    /// This write is the newest ask its slot has seen. The guard, when there is
    /// one, keeps every other writer's claim and gate out until this write's slot
    /// calls are done; `None` holds nothing, for a slot this side could not name.
    Open(Option<SlotHoldGuard<'a>>),
    /// A newer ask claimed the slot while this write was activating the policy
    /// object, so writing now would land on top of something asked for afterwards.
    Superseded(SlotClaim, u64),
}

/// Stand at the gate: refuse the write if a newer claim took its slot in the
/// meantime, otherwise keep the slot to this write until the guard is dropped.
///
/// The check and the hold are the same lock acquisition, which is what makes the
/// window close: between the read of the clock and the slot call there is no gap
/// another writer can claim through.
pub(super) fn hold_slot(claim: Option<&SlotClaim>) -> SlotHold<'static> {
    let Some(claim) = claim else {
        return SlotHold::Open(None);
    };
    let hold = slot_clock().lock().unwrap_or_else(|e| e.into_inner());
    if claim_is_newest(&hold, claim) {
        return SlotHold::Open(Some(hold));
    }
    let newest = hold.get(&claim.key).copied().unwrap_or(claim.ticket);
    drop(hold);
    SlotHold::Superseded(claim.clone(), newest)
}

/// The flow's own word for the log and for the refusal's wording.
pub(super) fn flow_name(data_flow: i32) -> &'static str {
    if data_flow == E_CAPTURE {
        "capture"
    } else {
        "render"
    }
}

/// The words a superseded write answers with.
///
/// Distinguishable because the two sides have to tell it apart from a plain
/// failure: a write the service refused leaves nothing in charge of the slot,
/// while a write refused here leaves a *newer* writer in charge, and the caller
/// must not "fall back" over that writer's choice. The user reads this string in
/// one Toast card, so it names the program and says what beat it.
pub(super) fn superseded_error(claim: &SlotClaim, newest: u64) -> AudioError {
    AudioError::Api(format!(
        "the {} assignment for {} was superseded by a newer one (this write was asked as #{}, \
         the slot is at #{})",
        flow_name(claim.key.1),
        claim.key.0,
        claim.ticket,
        newest
    ))
}

#[cfg(test)]
mod tests {
    use super::super::policy::E_RENDER;
    use super::*;

    /// Tickets are handed out in the order the writers arrive, one counter per
    /// slot, and nothing else moves them: a newer ask is by construction the
    /// larger number, and two programs never share a queue.
    #[test]
    fn claims_are_numbered_in_the_order_writers_arrive() {
        let mut clock = std::collections::HashMap::new();
        let chrome: SlotKey = ("chrome.exe".to_string(), E_RENDER);
        let edge: SlotKey = ("msedge.exe".to_string(), E_RENDER);
        assert_eq!(ticket_for(&mut clock, &chrome), 1);
        assert_eq!(ticket_for(&mut clock, &chrome), 2, "the next ask");
        assert_eq!(
            ticket_for(&mut clock, &edge),
            1,
            "another program starts a queue of its own"
        );
        assert_eq!(
            ticket_for(&mut clock, &("chrome.exe".to_string(), E_CAPTURE)),
            1,
            "and so does the other half of the same program's slot"
        );
    }

    /// The whole decision the gate makes, in one table: equal wins, older loses,
    /// and a stamp from anywhere but this program's own half of the slot is not
    /// consulted at all.
    #[test]
    fn only_the_newest_claim_for_a_slot_may_write() {
        let mut clock = std::collections::HashMap::new();
        let chrome: SlotKey = ("chrome.exe".to_string(), E_RENDER);
        for _ in 0..5 {
            ticket_for(&mut clock, &chrome);
        }
        let claim = |key: SlotKey, ticket: u64| SlotClaim { key, ticket };

        assert!(
            claim_is_newest(&clock, &claim(chrome.clone(), 5)),
            "equal counts as newest — the writer that owns the front gets through"
        );
        assert!(
            claim_is_newest(&clock, &claim(chrome.clone(), 6)),
            "a claim ahead of the clock is the same situation, not a loss"
        );
        assert!(
            !claim_is_newest(&clock, &claim(chrome.clone(), 4)),
            "one ask behind loses"
        );
        assert!(
            !claim_is_newest(&clock, &claim(chrome.clone(), 1)),
            "and so does one five asks behind"
        );

        assert!(
            claim_is_newest(&clock, &claim(("msedge.exe".to_string(), E_RENDER), 1)),
            "a slot only another executable has touched is irrelevant here"
        );
        assert!(
            claim_is_newest(&clock, &claim((chrome.0.clone(), E_CAPTURE), 1)),
            "the capture half is ordered apart from the render half of the same program"
        );
        assert!(
            claim_is_newest(&clock, &claim(("never-asked.exe".to_string(), E_RENDER), 9)),
            "a slot the clock has never seen is nothing to lose to"
        );
    }

    /// The gate holds the slot for the newest claim and refuses an older one — and
    /// holding it is what makes the check mean something: no ticket can be handed
    /// out while a writer is inside the slot, so a claim that passes never loses
    /// afterwards, and one that loses never wrote at all.
    #[test]
    fn the_gate_holds_the_slot_for_the_newest_claim_only() {
        let live = std::process::id();
        // Asked for a flow this program's own process can be named for, which is
        // the same witness the write path uses.
        let first = claim_endpoint_slot(live, E_CAPTURE).expect("the test process can name itself");
        match hold_slot(Some(&first)) {
            SlotHold::Open(hold) => assert!(hold.is_some(), "the newest claim holds its slot"),
            SlotHold::Superseded(_, newest) => {
                panic!("the first ask for a quiet slot lost it at #{newest}")
            }
        }

        let second = claim_endpoint_slot(live, E_CAPTURE).expect("the same program again");
        assert!(
            second.ticket > first.ticket,
            "the newer ask carries the larger ticket"
        );
        assert!(
            matches!(
                hold_slot(Some(&first)),
                SlotHold::Superseded(_, newest) if newest == second.ticket
            ),
            "and the ask it replaced is refused, naming who beat it"
        );
        match hold_slot(Some(&second)) {
            SlotHold::Open(hold) => assert!(hold.is_some(), "the newer claim still stands"),
            SlotHold::Superseded(_, newest) => panic!("the newest claim was refused at #{newest}"),
        }

        // A slot this side cannot name is not ordered — the release paths that walk
        // a process which has already gone must not be refused a hand-back.
        assert!(matches!(hold_slot(None), SlotHold::Open(None)));
    }

    /// One release walk speaks for a program's slot once, even when it is handed
    /// two of that program's processes: with a second ticket, the walk's own first
    /// release would be the older claim and get refused, so the walk would supersede
    /// itself and report one program handed back while it is still pinned.
    #[test]
    fn one_walk_holds_one_claim_per_slot() {
        let live = std::process::id();
        let mut held = std::collections::HashMap::new();
        let first =
            claim_walked_slot(live, E_RENDER, &mut held).expect("the test process can name itself");
        // The second process of one program is not something a unit test can conjure,
        // so the same pid is asked twice — which reaches the same slot by the same
        // road, and is the shape that used to take the second ticket.
        let again = claim_walked_slot(live, E_RENDER, &mut held).expect("the same program again");
        assert_eq!(first.ticket, again.ticket, "one slot, one ticket");
        assert_eq!(
            held.len(),
            1,
            "and the walk keys it by the slot, not the pid"
        );

        // The other half of the same program's assignment is a different slot, so a
        // walk that means it takes its own hold. The two tickets are not compared:
        // the clock numbers each slot on its own — a stamp from the recording half
        // deliberately says nothing about the playback one (see `claim_is_newest`),
        // so the two counters mean nothing to each other.
        let capture = claim_walked_slot(live, E_CAPTURE, &mut held)
            .expect("the same process, the recording half");
        assert_eq!(
            capture.key.1, E_CAPTURE,
            "the recording half is its own slot"
        );
        assert_eq!(held.len(), 2, "one hold per slot");
        let capture_again = claim_walked_slot(live, E_CAPTURE, &mut held)
            .expect("the same process, the recording half again");
        assert_eq!(
            capture.ticket, capture_again.ticket,
            "and a walk keeps the hold it already has on it"
        );
    }

    /// A writer that loses the slot has to say so in words that are not a service
    /// failure: the caller's rollback turns on which of the two happened, and the
    /// user reads this string as the whole explanation of a route that did not land.
    #[test]
    fn a_superseded_write_names_the_program_and_says_what_beat_it() {
        let render = SlotClaim {
            key: ("chrome.exe".to_string(), E_RENDER),
            ticket: 4,
        };
        let message = superseded_error(&render, 6).to_string();
        assert!(
            message.contains("superseded"),
            "the phrase the caller sorts on"
        );
        assert!(
            message.contains("chrome.exe"),
            "and the program it lost: {message}"
        );
        assert!(
            message.contains("render"),
            "and which half of its slot: {message}"
        );

        let capture = SlotClaim {
            key: ("recorder.exe".to_string(), E_CAPTURE),
            ticket: 1,
        };
        let message = superseded_error(&capture, 2).to_string();
        assert!(
            message.contains("capture") && message.contains("recorder.exe"),
            "the other half reads differently: {message}"
        );
    }
}
