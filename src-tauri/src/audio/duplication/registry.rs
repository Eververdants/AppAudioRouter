//! In-flight-start bookkeeping, so a stop can never miss a landing start.
//!
//! [`StartRegistry`] is the handshake between a `start` that is walking its slow
//! COM path and a `stop` that arrives mid-walk: the start declares itself under
//! the same lock as its eviction, the stop waits for the count to drain before it
//! removes, and a stop that gave up waiting leaves a *ticket* the in-flight starts
//! honour by refusing the seat at their insertion ([`super::start`]). The docs on
//! [`StartRegistry`] and [`StartRegistry::wait_for_quiet`] carry the ordering
//! argument, including why the wait is bounded and why a timeout has a defined
//! outcome rather than a pending one.
//!
//! [`StartGuard`] is the other half: it clears one start on every return path out
//! of `start`, so a start that never lands cannot strand a waiting `stop`.

use std::collections::HashMap;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

/// In-flight-start bookkeeping, so a stop can never miss a landing start.
///
/// `start` registers itself here, under the same `engines` lock as its
/// eviction, *before* the slow COM work (mix format, session-volume claim);
/// `stop` waits for the count to drain before removing. Without this, a
/// `stop_route` landing between a start's eviction and its insertion removes
/// nothing, and the insertion then RESURRECTS an engine with no route — the
/// mirrors keep playing while the board shows nothing.
///
/// The wait is bounded (see [`START_SETTLE_TIMEOUT`]) and its timeout has a
/// defined outcome: the stop leaves a *ticket* on the pid, and every start that
/// was already in flight refuses the seat when it reaches its insertion. Between
/// the ticket and the eviction the invariant holds either way — a start that
/// seated before the ticket was written is removed by that eviction, and one
/// that reaches the insertion after it withdraws — so a `stop` that returns
/// means no engine is or will be seated, whether or not it had to wait.
#[derive(Default)]
pub(super) struct StartRegistry {
    /// Counts and tickets together with the sequence they are compared against:
    /// one lock, so a ticket's boundary covers exactly the starts begun before
    /// it was written.
    ledger: Mutex<StartLedger>,
    /// Notified on every decrement, so a waiting `stop` cannot sleep past
    /// the start it waits for.
    landed: Condvar,
}

/// What [`StartRegistry`] keeps under its lock.
#[derive(Default)]
struct StartLedger {
    /// pid → its in-flight starts. More than one because two `apply_route`s for
    /// the same pid can overlap; the pid stays claimed until both settle.
    entries: HashMap<u32, StartEntry>,
    /// Monotonic start sequence, handed out under this lock.
    pub(super) sequence: u64,
}

/// One pid's in-flight starts and the stop ticket they must honour.
#[derive(Default)]
struct StartEntry {
    /// Starts that have evicted the incumbent and not yet landed (or withdrawn).
    count: u32,
    /// Sequence boundary written by a stop that gave up waiting: a start whose
    /// own sequence is below it must withdraw instead of seating. Zero is
    /// "nobody is waiting", which no sequence can be below.
    ticket: u64,
}

impl StartRegistry {
    /// Count one more in-flight start for `pid` and return its sequence. Called
    /// while the caller holds the `engines` lock — that pairing is what makes
    /// the eviction and the registration one step no `stop` can slip between.
    pub(super) fn begin(&self, pid: u32) -> u64 {
        let mut ledger = self.ledger.lock().unwrap_or_else(|e| e.into_inner());
        ledger.sequence = ledger.sequence.saturating_add(1);
        let entry = ledger.entries.entry(pid).or_default();
        entry.count = entry.count.saturating_add(1);
        ledger.sequence
    }

    /// One fewer. The notify is unconditional: a waiter for another pid
    /// re-checks its own entry and sleeps again, and losing this one's wake
    /// would strand a `stop` past a start that already landed. Dropping the
    /// entry at zero drops its ticket with it, so a refusal cannot outlive the
    /// starts it was written for and never reaches the next route.
    pub(super) fn clear(&self, pid: u32) {
        let mut ledger = self.ledger.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = ledger.entries.get_mut(&pid) {
            entry.count = entry.count.saturating_sub(1);
        }
        if ledger
            .entries
            .get(&pid)
            .is_some_and(|entry| entry.count == 0)
        {
            ledger.entries.remove(&pid);
        }
        self.landed.notify_all();
    }

    /// Sleep until `pid` has no start in flight, at most `budget`.
    ///
    /// `true`: the starts settled, and the caller's removal then sees whatever
    /// they landed — or nothing, if they withdrew. `false`: the budget ran out,
    /// every start already begun has been ticketed, and the caller must remove
    /// what it can and let the ticket deal with the rest.
    ///
    /// A stop arriving before any start registered does not wait and tickets
    /// nothing: honoring a stop over a *later* apply is the frontend's
    /// ordering, and a route the user asked for after the stop has finished is
    /// simply the next word, not a resurrection.
    pub(super) fn wait_for_quiet(&self, pid: u32, budget: Duration) -> bool {
        let deadline = Instant::now() + budget;
        let mut ledger = self.ledger.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            if !ledger.entries.contains_key(&pid) {
                return true;
            }
            if Instant::now() >= deadline {
                // Every start begun up to and including `sequence` was already
                // in flight when this stop gave up; those, and only those, are
                // refused the seat.
                let boundary = ledger.sequence.saturating_add(1);
                if let Some(entry) = ledger.entries.get_mut(&pid) {
                    entry.ticket = entry.ticket.max(boundary);
                }
                return false;
            }
            let (guard, _waited) = self
                .landed
                .wait_timeout(ledger, deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|e| e.into_inner());
            ledger = guard;
        }
    }

    /// Whether this start must give up the seat because a stop stopped waiting
    /// for it. Called by the start under the `engines` lock, which is what makes
    /// the refusal and the stop's eviction one ordering: either this sees the
    /// ticket, or the eviction that wrote it finds the engine already seated.
    pub(super) fn should_withdraw(&self, pid: u32, sequence: u64) -> bool {
        let ledger = self.ledger.lock().unwrap_or_else(|e| e.into_inner());
        ledger
            .entries
            .get(&pid)
            .is_some_and(|entry| sequence < entry.ticket)
    }

    /// Refuse the seat to every start in flight, for a caller that cannot wait
    /// on any of them (the shutdown sweep, which runs while the app is closing).
    /// Returns how many pids had a start to refuse.
    pub(super) fn ticket_all(&self) -> usize {
        let mut ledger = self.ledger.lock().unwrap_or_else(|e| e.into_inner());
        let boundary = ledger.sequence.saturating_add(1);
        for entry in ledger.entries.values_mut() {
            entry.ticket = entry.ticket.max(boundary);
        }
        ledger.entries.len()
    }
}

/// Clears one in-flight start on the way out of `DuplicationManager::start`,
/// on every return path — including the `?` and early `Err`/`Ok` returns that
/// happen before an engine lands. A start that never lands must not leave a
/// `stop` waiting on a count nobody will clear.
pub(super) struct StartGuard<'a> {
    pub(super) registry: &'a StartRegistry,
    pub(super) pid: u32,
    /// This start's own sequence, as handed out by [`StartRegistry::begin`].
    pub(super) sequence: u64,
}

impl StartGuard<'_> {
    /// Whether a `stop` gave up waiting for this start, so taking the seat now
    /// would resurrect the route that stop just answered for.
    pub(super) fn stop_arrived(&self) -> bool {
        self.registry.should_withdraw(self.pid, self.sequence)
    }
}

impl Drop for StartGuard<'_> {
    fn drop(&mut self) {
        self.registry.clear(self.pid);
    }
}
