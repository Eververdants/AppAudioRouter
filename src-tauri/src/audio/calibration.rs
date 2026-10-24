//!
//! The measurement side of the delay-calibration wizard: play a few short tone
//! bursts on one device and let the user time them with a held button.
//!
//! The backend's job is only to make the bursts predictable and to mark them.
//! Each burst is bracketed by two `calibration-tone` events — `start` when the
//! first tone frame is written into the endpoint, `end` when the last one is —
//! and the frontend timestamps those arrivals and the user's press/release
//! against its own clock. The *offset* between the two midpoints is what a
//! device's inherent latency (endpoint pipeline plus whatever the hardware, a
//! Bluetooth codec above all, adds) contributes to; everything the two
//! measurements share — the human reaction time, the write-ahead padding this
//! player keeps, the event delivery — is common to every device and cancels
//! when one device's offset is subtracted from another's. That difference is
//! the whole product: the wizard writes compensation values, never absolutes.
//!
//! Playback is the same shape as a mirror's render loop (event-driven shared
//! client, buffer topped up towards a fixed padding target) so the conversion
//! path and the pacing jitter a burst experiences match what a real copy would.
//!
//! The run is parameterized (`reps`, `lead_ms`, `tail_ms`) because the wizard
//! interleaves devices: instead of one long per-device sequence it drives one
//! short burst per call, rotating through the devices round by round. That
//! rotation keeps whatever drifts in the user's reaction time over a session
//! (warming up, tiring) common to every device, instead of biasing whichever
//! one happened to be measured first. Between calls the frontend draws a fresh
//! random lead, so the pace stays unpredictable across the whole session; the
//! short tail between calls is safe because the pump paces its writes at the
//! fixed padding target — by the time a schedule ends, the burst is already
//! audible and only padding-depth silence remains in the buffer.
//!
//! This file is the module root; the code lives in the submodules below, one
//! per seam the descriptions above already draw:
//!
//! - [`state`] — the one run at a time and the bookkeeping it leaves behind:
//!   who may begin, what a cancel marks, and the guards that hand the busy flag
//!   and the render event back.
//! - [`schedule`] — what gets played when: the segment list, the gap drawn per
//!   rep, the burst's own waveform, and the bounds a caller's lead and tail are
//!   clamped through.
//! - [`player`] — the device I/O: the apartment, the endpoint, the mix format
//!   read for its channel count and encoding, and the stream one burst is
//!   written through.
//! - [`pump`] — the render loop that feeds that stream and brackets each burst
//!   with the `calibration-tone` `start`/`end` pair the frontend times.
//!
//! The constants below are the contract with the frontend — how long a burst
//! sounds, how many a round asks for, the lead and tail it draws, and the token
//! a caller that names no run uses — so they stay here, together with the paths
//! the rest of the crate names; tests stay with the code they cover, in these
//! same files.

mod player;
mod pump;
mod schedule;
mod state;

// The paths the rest of the crate names, re-exported so they keep resolving as
// `audio::calibration::X`. The submodules themselves stay private: the gate and
// the stream are two halves of one promise — one burst at a time, cancellable,
// marked — and a second route into either, or a schedule pushed straight at a
// device without the pump's pacing, is exactly how that promise breaks.
pub use self::player::play_test_tone;
pub use self::state::{cancel_live_run, CalibrationState, Refusal};

// The rest of the surface, kept reachable under the same name for the same
// reason: nothing outside this module happens to spell `BusyGuard` today — it is
// only ever carried by the pair `CalibrationState::worker_tokens` hands to the
// worker — and a binary crate reports a `pub use` nothing references as
// `unused_imports`, which would turn a pure split into a broken build and a
// narrower public surface at once.
#[allow(unused_imports)]
pub use self::state::BusyGuard;

/// How long one burst sounds, in milliseconds. Long enough to press and hold
/// comfortably, short enough that three of them with pauses stay quick.
pub const TONE_BURST_MS: usize = 800;
/// Bursts per run when the caller does not choose. Three presses average out
/// the reaction jitter; the frontend discards a press whose hold duration does
/// not match the burst.
pub const TONE_REPS_DEFAULT: usize = 3;
/// Upper bound on caller-supplied bursts: the wizard's round-robin re-enters
/// this command once per burst, so one call must never turn into a marathon.
pub const TONE_REPS_MAX: usize = 6;
/// Silence before the first burst, and after each one. The tail lets a burst
/// finish audibly before the schedule ends. The wizard's round-robin passes a
/// shorter tail per call and randomizes the lead itself (see the module doc);
/// these defaults describe a standalone single-device sequence.
pub const LEAD_MS_DEFAULT: usize = 500;
pub const TAIL_MS_DEFAULT: usize = 900;

/// The run token a caller that names no run uses.
///
/// A start carrying it is never refused for staleness, because there is nothing
/// to match: the shell's window teardown, which is the caller that names no run,
/// keeps the behaviour the player had before runs were counted, and only a
/// caller that passes a real token gets the stale-start refusal. Zero is free for
/// that purpose because a real token names one run and is never reused — not by
/// a later run of the page that minted it, and not by a page reloaded over a
/// mark the earlier one left (`DelayCalibration`'s `mintRunToken`).
pub const NO_RUN_TOKEN: u64 = 0;
