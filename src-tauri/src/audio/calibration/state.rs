//! The one-run-at-a-time gate and the run bookkeeping.
//!
//! [`CalibrationState`] is what keeps the player's promise: one burst sounding at
//! a time, a cancel that reaches it within one backstop interval, and a counter
//! that tells a start older than the user's cancel apart from a fresh one.
//! [`CalibrationState::begin`] decides all three, and [`Refusal`] says which of
//! them stopped a start.
//!
//! The two guards belong here for the same reason they belong to the gate: they
//! are how a run is handed back. [`BusyGuard`] releases the busy flag on every
//! exit path of the worker, panics included, and [`EventHandle`] closes the kernel
//! event the pump waits on — declared ahead of the audio client so the drop order
//! holds on the early returns as well as the planned one (see [`super::player`]).
//!
//! [`cancel_live_run`] is the shell's door. A window that went away cannot call
//! `calibration_cancel`, so `main.rs` asks this to stop the burst nobody can
//! report any more.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use log::debug;
use tauri::{AppHandle, Manager};
use windows::Win32::Foundation::{CloseHandle, HANDLE};

use super::NO_RUN_TOKEN;
/// Why the tone player did not admit a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// Another burst is already playing: two devices sounding into each other's
    /// measurement would ruin both.
    Busy,
    /// The wizard had already cancelled this run by the time the request reached
    /// the player, so playing now would sound into a dialog that is gone.
    Cancelled,
}

impl Refusal {
    /// The words `calibration_start` answers with.
    ///
    /// Both cases say something the wizard can sort without guessing. A stale
    /// start says `calibration superseded`: the run it was going to play has
    /// already been called off, so the loop that awaited it must not read a
    /// measurement into a burst nobody heard — and by construction the wizard that
    /// cancelled is no longer on the measure screen, which is why it may also treat
    /// the phrase as its own doing. The busy case deliberately says neither of the
    /// cancellation phrases, because a start refused while a burst nobody cancelled
    /// is still sounding is a failure worth showing.
    pub fn message(&self) -> &'static str {
        match self {
            Refusal::Busy => "a calibration run is already in progress",
            Refusal::Cancelled => {
                "calibration superseded (this run was cancelled before it started)"
            }
        }
    }
}

/// Shared state for the tone player, managed by Tauri.
///
/// `busy` admits one run at a time — two devices playing bursts into each
/// other's measurement would ruin both. `cancel_epoch` is the run's stop
/// signal: a cancel moves the epoch, and a run plays only while the epoch it
/// was admitted at is the one standing — so a cancel is never *cleared*, and
/// there is no window in which one can be wiped by a start landing after it.
///
/// `generation` counts the cancels this player has taken. `cancelled_run` holds
/// the run identity the most recent of them named, and `stale_generation` the
/// generation of a cancel that found nothing sounding. Those three answer the one
/// question the player could not answer before: whether the start now being
/// admitted was asked for *before* the user said stop. See
/// [`CalibrationState::begin`].
#[derive(Default)]
pub struct CalibrationState {
    busy: Arc<AtomicBool>,
    cancel_epoch: Arc<AtomicU64>,
    generation: AtomicU64,
    cancelled_run: AtomicU64,
    stale_generation: AtomicU64,
}

impl CalibrationState {
    /// Admit the run `run` identifies, returning the cancel epoch it plays
    /// under; `NO_RUN_TOKEN` for a caller that names none.
    ///
    /// A start is refused as stale when the user had already called this run off
    /// while the request was still in flight. That race is real and one-sided: the
    /// wizard awaits one burst at a time, so its Escape can be handled here
    /// *before* the start it was pressing Escape about has been admitted (the
    /// cancel runs on the IPC thread, the start body on the runtime's worker).
    /// Without a refusal the burst would sound into a dialog the user has already
    /// closed — the frontend can re-cancel the late answer and hope, but only the
    /// player can tell a cancel from the start it outranks.
    ///
    /// Two ways to tell, because the caller may or may not name its run:
    ///
    /// * a named cancel records the run it meant, and a start carrying that same
    ///   token is by construction older than it — precise, and never in the way of
    ///   any other run;
    /// * an unnamed cancel that finds **no burst sounding** can only have been sent
    ///   against a start that has not been admitted yet (a caller that names no run
    ///   asks to stop only while a loop of its own is measuring, and while a burst
    ///   is admitted `busy` is set), so it marks the generation and the next start
    ///   to arrive is refused.
    ///
    /// Either mark is spent by the refusal it was aimed at, so a run that comes
    /// afterwards is never refused twice. The epoch makes the rest of the
    /// ordering free: the run captures the epoch *before* anything is claimed,
    /// so every cancel that lands after that capture — named or not, aimed at
    /// this run or racing the admission itself — moves the epoch away from it and
    /// stops it at the pump's next check, and every cancel that predates the
    /// capture belongs to an earlier run and is inherited rather than replayed.
    /// A start refused as busy claims nothing and disturbs nothing.
    pub fn begin(&self, run: u64) -> Result<u64, Refusal> {
        let admitted = self.cancel_epoch.load(Ordering::SeqCst);
        if run != NO_RUN_TOKEN && self.cancelled_run.load(Ordering::SeqCst) == run {
            // Consumed only for the run it names: a cancel aimed at this start
            // cannot also be a cancel the next start has to survive.
            let _ = self.cancelled_run.compare_exchange(
                run,
                NO_RUN_TOKEN,
                Ordering::SeqCst,
                Ordering::SeqCst,
            );
            return Err(Refusal::Cancelled);
        }
        if self.stale_generation.swap(NO_RUN_TOKEN, Ordering::SeqCst) != NO_RUN_TOKEN {
            return Err(Refusal::Cancelled);
        }
        if self
            .busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(Refusal::Busy);
        }
        // The slot is ours, so a cancel naming this run that landed while the
        // admission was in flight is refused here — and one landing after this
        // line still stops the run at the pump, because it moved the epoch the
        // run was not admitted under. The same re-check guards the unnamed
        // cancel that found nothing playing and marked the start still in
        // flight. Both hand the slot back before refusing: nothing will run to
        // hand it over.
        if run != NO_RUN_TOKEN
            && self
                .cancelled_run
                .compare_exchange(run, NO_RUN_TOKEN, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
        {
            self.busy.store(false, Ordering::SeqCst);
            return Err(Refusal::Cancelled);
        }
        if self.stale_generation.swap(NO_RUN_TOKEN, Ordering::SeqCst) != NO_RUN_TOKEN {
            self.busy.store(false, Ordering::SeqCst);
            return Err(Refusal::Cancelled);
        }
        Ok(admitted)
    }

    /// A cloneable handle pair for the worker thread, so the guard and the
    /// cancel epoch can cross into `spawn_blocking`.
    pub fn worker_tokens(&self) -> (BusyGuard, Arc<AtomicU64>) {
        (BusyGuard(self.busy.clone()), self.cancel_epoch.clone())
    }

    /// Records the user's request to stop the run `run`, which may be
    /// `NO_RUN_TOKEN` when the caller names none.
    ///
    /// The epoch moves whichever way: a cancel must always reach the burst that is
    /// sounding right now, and the marks only decide what may still *begin*.
    ///
    /// The mark lands **before** the epoch moves. Under the sequentially
    /// consistent total order, any `begin` whose epoch capture already saw this
    /// cancel's bump must also see this cancel's mark — the reverse order would
    /// leave a window where a start is admitted at the standing (bumped) epoch
    /// while the mark naming it is still in flight, and the burst plays into a
    /// dialog the user already closed.
    pub fn cancel(&self, run: u64) {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if run == NO_RUN_TOKEN {
            // No run named, so the ordering has to be inferred from what was
            // sounding: nothing was, which means the start this cancel answers has
            // not reached `begin` yet.
            if !self.is_running() {
                self.stale_generation.store(generation, Ordering::SeqCst);
            }
        } else {
            self.cancelled_run.store(run, Ordering::SeqCst);
        }
        self.cancel_epoch.fetch_add(1, Ordering::SeqCst);
        if run == NO_RUN_TOKEN {
            debug!("calibration cancelled at generation {generation}");
        } else {
            debug!("calibration run {run} cancelled at generation {generation}");
        }
    }

    /// How many cancels this player has taken. A run's start and its cancel are
    /// told apart by nothing else on this side, so the count is what the log and
    /// the tests read.
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// Whether a run is playing right now.
    pub fn is_running(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }
}

/// Stop the burst that is sounding because nobody can hear it any more.
///
/// The window going away is the shell's knowledge, not the page's: hidden to the
/// tray the React tree never unmounts, so nothing calls `calibration_cancel`, and
/// a lost webview could not call it if it wanted to. Cancelling is a store on an
/// atomic — no join, no lock, nothing the event loop can be held by — and the pump
/// ends itself within one backstop interval, so this returns while the burst is
/// still winding down rather than waiting for it.
///
/// Returns whether a run was standing to be stopped, so the caller can say which
/// window events actually cost a burst — and logs nothing, because it is the shell
/// that knows why the window went away.
pub fn cancel_live_run(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<CalibrationState>() else {
        return false;
    };
    if !state.is_running() {
        return false;
    }
    state.cancel(NO_RUN_TOKEN);
    true
}

/// Hands the busy flag back on every exit path of the worker, panics included.
pub struct BusyGuard(Arc<AtomicBool>);

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// One kernel event handle that closes itself.
pub(super) struct EventHandle(pub(super) HANDLE);

impl Drop for EventHandle {
    fn drop(&mut self) {
        // SAFETY: this guard is the only owner; the handle came from CreateEventW.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wizard cancels freely — Escape, the cancel button, unmount — and
    /// then measures again from the same screen. A cancel request that outlived
    /// its run would fail every later run at the pump's first check, which the
    /// frontend reads as its own doing and swallows: the wizard would sit on
    /// the measure screen with no burst and no error until the app restarted.
    #[test]
    fn a_new_run_does_not_inherit_the_previous_cancel() {
        let state = CalibrationState::default();
        let admitted = state
            .begin(NO_RUN_TOKEN)
            .expect("the first run is admitted");
        let (_guard, cancel_epoch) = state.worker_tokens();
        state.cancel(NO_RUN_TOKEN);
        assert_ne!(
            cancel_epoch.load(Ordering::SeqCst),
            admitted,
            "the running run is cancellable"
        );
        drop(_guard);

        let admitted = state
            .begin(NO_RUN_TOKEN)
            .expect("the run is over, so the next one is admitted");
        let (_guard, cancel_epoch) = state.worker_tokens();
        assert_eq!(
            cancel_epoch.load(Ordering::SeqCst),
            admitted,
            "the fresh run must not start pre-cancelled"
        );

        // A second begin while one runs is refused, and must not disturb the
        // running run's cancel epoch.
        assert!(matches!(state.begin(NO_RUN_TOKEN), Err(Refusal::Busy)));
        assert_eq!(
            cancel_epoch.load(Ordering::SeqCst),
            admitted,
            "the refused start left the live run's epoch alone"
        );
        state.cancel(NO_RUN_TOKEN);
        assert_ne!(cancel_epoch.load(Ordering::SeqCst), admitted);
    }

    /// The race the run counter exists for. The wizard awaits one burst at a
    /// time and its Escape goes on the IPC thread, so a cancel can be handled
    /// before the start it was answering has been admitted: without a refusal,
    /// that start would sound into a dialog the user already closed. The
    /// frontend can only re-cancel the late answer and hope; the player knows
    /// which side arrived first.
    #[test]
    fn a_start_older_than_the_last_cancel_is_refused() {
        let state = CalibrationState::default();
        // Nothing was playing when the cancel arrived, so all it leaves behind is
        // its mark on run 7.
        state.cancel(7);
        assert_eq!(state.generation(), 1, "the cancel moved the run generation");
        assert!(
            !state.is_running(),
            "a cancel with nothing playing starts nothing"
        );

        assert!(matches!(state.begin(7), Err(Refusal::Cancelled)));
        assert!(
            Refusal::Cancelled.message().contains("superseded"),
            "the refusal names the wizard's own phrase for a run called off under it"
        );
        assert!(
            !Refusal::Busy.message().contains("superseded"),
            "a collision nobody caused stays reportable"
        );
        assert!(!state.is_running(), "a refused start did not take the slot");

        // The refusal spends the cancel it was aimed at, so the retry — which is a
        // new run, and a new run carries a new token — gets its burst, and gets it
        // un-cancelled.
        let admitted = state.begin(8).expect("the retried run is admitted");
        assert!(state.is_running());
        let (_guard, cancel_epoch) = state.worker_tokens();
        assert_eq!(
            cancel_epoch.load(Ordering::SeqCst),
            admitted,
            "the retried run is not pre-cancelled"
        );
    }

    /// The same race as above for a wizard that names no run — which is the one
    /// shipping today. A cancel that finds no burst sounding cannot have been sent
    /// against a run the player has admitted (that is what `busy` says), so the
    /// only thing it can be answering is a start still in flight, and that start
    /// is refused when it lands. A cancel that finds a burst playing needs no mark
    /// at all: it stops it.
    #[test]
    fn a_cancel_with_nothing_playing_outranks_the_next_start() {
        let state = CalibrationState::default();
        {
            // A cancel over a run that is sounding leaves no mark behind: the burst
            // it stops is in front of the player's eyes.
            let admitted = state.begin(NO_RUN_TOKEN).expect("admitted");
            let (_guard, cancel_epoch) = state.worker_tokens();
            state.cancel(NO_RUN_TOKEN);
            assert_ne!(
                cancel_epoch.load(Ordering::SeqCst),
                admitted,
                "the live burst is stopped"
            );
        }

        // Idle now, so this cancel cannot be answering a run the player admitted —
        // only a start that has not landed yet.
        state.cancel(NO_RUN_TOKEN);
        assert!(matches!(state.begin(NO_RUN_TOKEN), Err(Refusal::Cancelled)));
        let admitted = state
            .begin(NO_RUN_TOKEN)
            .expect("and the mark is spent, so the run after it plays");
        let (_guard, cancel_epoch) = state.worker_tokens();
        assert_eq!(cancel_epoch.load(Ordering::SeqCst), admitted);
    }

    /// A cancel must always reach the burst that is sounding, whichever run the
    /// caller meant it for — and naming a run must never be what stops the *next*
    /// one from playing.
    #[test]
    fn a_cancel_stops_what_is_playing_and_refuses_only_the_run_it_named() {
        let state = CalibrationState::default();
        let admitted = state.begin(1).expect("admitted");
        let (_guard, cancel_epoch) = state.worker_tokens();
        // Aimed at a run that never started; the live burst still ends.
        state.cancel(99);
        assert_ne!(
            cancel_epoch.load(Ordering::SeqCst),
            admitted,
            "a cancel nobody can match still stops the sound"
        );
        drop(_guard);

        let admitted = state
            .begin(2)
            .expect("a cancel for another run refuses nothing else");
        let (_guard, cancel_epoch) = state.worker_tokens();
        assert_eq!(
            cancel_epoch.load(Ordering::SeqCst),
            admitted,
            "and the run that plays afterwards is not pre-cancelled"
        );
    }

    /// The regression the epoch exists to close: a start refused as busy used to
    /// wipe the live run's pending cancel on its way through, because the clear
    /// of the shared flag ran before the slot check. With the epoch nothing is
    /// cleared, so the refusal — like every other begin — claims nothing and
    /// disturbs nothing, and a named cancel waiting for its own run is not
    /// spent by a start that never played.
    #[test]
    fn a_start_refused_as_busy_disturbs_nothing() {
        let state = CalibrationState::default();
        let admitted = state.begin(NO_RUN_TOKEN).expect("admitted");
        let (_guard, cancel_epoch) = state.worker_tokens();
        state.cancel(NO_RUN_TOKEN);
        assert!(matches!(state.begin(NO_RUN_TOKEN), Err(Refusal::Busy)));
        assert_ne!(
            cancel_epoch.load(Ordering::SeqCst),
            admitted,
            "the pending cancel survives a busy-refused start"
        );
        drop(_guard);

        // A named cancel waiting for its own run is also not spent by the
        // refused start: the next unnamed run plays, and run 9's start — when it
        // comes — is still refused.
        state.cancel(9);
        let admitted = state
            .begin(NO_RUN_TOKEN)
            .expect("a start nobody named a cancel for plays");
        assert_eq!(cancel_epoch.load(Ordering::SeqCst), admitted);
        assert!(matches!(state.begin(9), Err(Refusal::Cancelled)));
    }

    /// The last gap the flag could not close: a named cancel landing while its
    /// start is being admitted. The token is re-checked after the slot is taken —
    /// and even one that lands after *that* line still stops the run, because it
    /// moved the epoch the run was not admitted under. No interleaving plays a
    /// burst into a dialog the user already closed.
    #[test]
    fn a_named_cancel_that_races_the_admission_is_refused_or_stops_the_run() {
        let state = CalibrationState::default();
        // The cancel lands between the token check and the slot: the re-check
        // after the slot refuses the start, and hands the slot back.
        state.cancel(5);
        assert!(matches!(state.begin(5), Err(Refusal::Cancelled)));
        assert!(
            !state.is_running(),
            "the refused start did not hold the slot"
        );

        // One landing after admission cannot be refused any more — but the run
        // stops itself at the pump's first check, because the epoch moved.
        let admitted = state.begin(6).expect("admitted");
        let (_guard, cancel_epoch) = state.worker_tokens();
        state.cancel(6);
        assert_ne!(cancel_epoch.load(Ordering::SeqCst), admitted);
    }
}
