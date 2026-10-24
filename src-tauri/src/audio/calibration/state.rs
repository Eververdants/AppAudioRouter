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
/// other's measurement would ruin both. `cancel` is watched between every
/// write, so closing the wizard ends the run within one backstop interval.
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
    cancel: Arc<AtomicBool>,
    generation: AtomicU64,
    cancelled_run: AtomicU64,
    stale_generation: AtomicU64,
}

impl CalibrationState {
    /// Admit the run `run` identifies; `NO_RUN_TOKEN` for a caller that names none.
    ///
    /// A start is refused as stale when the user had already called this run off
    /// while the request was still in flight. That race is real and one-sided: the
    /// wizard awaits one burst at a time, so its Escape can be handled here
    /// *before* the start it was pressing Escape about has been admitted (the
    /// cancel runs on the IPC thread, the start body on the runtime's worker).
    /// Without the check the start clears the cancel flag the cancel had just set
    /// and the burst sounds into a dialog the user has already closed — the
    /// frontend can re-cancel the late answer and hope, but only the player can
    /// tell a cancel from the start it outranks.
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
    /// afterwards is never refused twice, and a start that arrives while one is
    /// playing is refused as busy *without* disturbing the live run's cancel flag
    /// or a mark another start still owns.
    pub fn begin(&self, run: u64) -> Result<(), Refusal> {
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
        // A fresh run must not inherit the previous run's cancel request. The
        // flag is never cleared on the way out, so without this every run after
        // the first cancel would fail at once — and the wizard reads
        // "calibration cancelled" as its own doing, leaving the measure screen
        // standing with neither a burst nor an error to explain it.
        self.cancel.store(false, Ordering::SeqCst);
        Ok(())
    }

    /// A cloneable handle pair for the worker thread, so the guard and the
    /// cancel flag can cross into `spawn_blocking`.
    pub fn worker_tokens(&self) -> (BusyGuard, Arc<AtomicBool>) {
        (BusyGuard(self.busy.clone()), self.cancel.clone())
    }

    /// Records the user's request to stop the run `run`, which may be
    /// `NO_RUN_TOKEN` when the caller names none.
    ///
    /// The flag is set whichever way: a cancel must always reach the burst that is
    /// sounding right now, and the marks only decide what may still *begin*.
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
        self.cancel.store(true, Ordering::SeqCst);
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
        assert_eq!(
            state.begin(NO_RUN_TOKEN),
            Ok(()),
            "the first run is admitted"
        );
        let (_guard, cancel) = state.worker_tokens();
        state.cancel(NO_RUN_TOKEN);
        assert!(
            cancel.load(Ordering::SeqCst),
            "the running run is cancellable"
        );
        drop(_guard);

        assert_eq!(
            state.begin(NO_RUN_TOKEN),
            Ok(()),
            "the run is over, so the next one is admitted"
        );
        let (_guard, cancel) = state.worker_tokens();
        assert!(
            !cancel.load(Ordering::SeqCst),
            "the fresh run must not start pre-cancelled"
        );

        // A second begin while one runs is refused, and must not disturb the
        // running run's cancel flag.
        assert_eq!(state.begin(NO_RUN_TOKEN), Err(Refusal::Busy));
        assert!(
            !cancel.load(Ordering::SeqCst),
            "the refused start left the live run's flag alone"
        );
        state.cancel(NO_RUN_TOKEN);
        assert!(cancel.load(Ordering::SeqCst));
    }

    /// The race the run counter exists for. The wizard awaits one burst at a
    /// time and its Escape goes on the IPC thread, so a cancel can be handled
    /// before the start it was answering has been admitted: without a refusal,
    /// that start clears the flag the cancel just set and the burst sounds into a
    /// dialog the user already closed. The frontend can only re-cancel the late
    /// answer and hope; the player knows which side arrived first.
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

        assert_eq!(
            state.begin(7),
            Err(Refusal::Cancelled),
            "a start the user already cancelled is refused"
        );
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
        assert_eq!(state.begin(8), Ok(()));
        assert!(state.is_running());
        let (_guard, cancel) = state.worker_tokens();
        assert!(
            !cancel.load(Ordering::SeqCst),
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
            assert_eq!(state.begin(NO_RUN_TOKEN), Ok(()));
            let (_guard, cancel) = state.worker_tokens();
            state.cancel(NO_RUN_TOKEN);
            assert!(cancel.load(Ordering::SeqCst), "the live burst is stopped");
        }

        // Idle now, so this cancel cannot be answering a run the player admitted —
        // only a start that has not landed yet.
        state.cancel(NO_RUN_TOKEN);
        assert_eq!(
            state.begin(NO_RUN_TOKEN),
            Err(Refusal::Cancelled),
            "the start that was still in flight is refused instead of played"
        );
        assert_eq!(
            state.begin(NO_RUN_TOKEN),
            Ok(()),
            "and the mark is spent, so the run after it plays"
        );
    }

    /// A cancel must always reach the burst that is sounding, whichever run the
    /// caller meant it for — and naming a run must never be what stops the *next*
    /// one from playing.
    #[test]
    fn a_cancel_stops_what_is_playing_and_refuses_only_the_run_it_named() {
        let state = CalibrationState::default();
        assert_eq!(state.begin(1), Ok(()));
        let (_guard, cancel) = state.worker_tokens();
        // Aimed at a run that never started; the live burst still ends.
        state.cancel(99);
        assert!(
            cancel.load(Ordering::SeqCst),
            "a cancel nobody can match still stops the sound"
        );
        drop(_guard);

        assert_eq!(
            state.begin(2),
            Ok(()),
            "a cancel for another run refuses nothing else"
        );
        let (_guard, cancel) = state.worker_tokens();
        assert!(
            !cancel.load(Ordering::SeqCst),
            "and the run that plays afterwards is not pre-cancelled"
        );
    }
}
