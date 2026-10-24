//! Multi-device audio duplication ("route one app to several devices").
//!
//! Windows assigns exactly one default endpoint per app, so routing an app to
//! N > 1 devices is built from two channels:
//!
//! 1. Primary — device #1 becomes the app's persisted default endpoint via
//!    `AudioPolicyConfig` (see `routing.rs`); its audio flows there natively.
//! 2. Mirrors — every further device receives a software copy of the app's
//!    audio, produced here: a WASAPI *process loopback* capture taps the
//!    process's mixed output, and one event-driven render client per mirror
//!    device writes the same frames into that device.
//!
//! The tap uses `ActivateAudioInterfaceAsync` with
//! `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` (Windows 10 build 20348+).
//! Capture and mirror devices may run different mix formats: both sides
//! initialize with `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM` and
//! `AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY`, so WASAPI converts between the
//! shared capture format and each device's engine format. No virtual-audio
//! driver is involved, which keeps the project free of third-party executables.
//!
//! Lifecycle: [`DuplicationManager`] (Tauri state) owns one engine per PID.
//! Each engine is a capture thread plus one render thread per mirror. Threads
//! watch a shared `shutdown` flag and, when it is set — or when the target
//! process exits — they clean up, unregister the engine, and notify the
//! frontend via the `duplication-stopped` event. A single mirror that cannot be
//! opened or that errors out later does not take the engine down: it is dropped
//! from the route and reported on its own through `duplication-mirror-failed`,
//! so the remaining devices keep playing and the UI can say which one went quiet.
//! When *every* mirror fails, though, the loopback tap has no consumer left: the
//! engine releases its capture client and holds — registered, quiet, waiting for
//! a stop or the process's end — because a `duplication-stopped` would take the
//! still-playing primary route off the board with it. The state says as much:
//! `active_routes` reports such an engine on the primary device alone.
//!
//! Synchronization: render clients do not start independently. The capture
//! thread opens a gate once every device is initialized and every ring holds
//! one base pipeline of pre-roll (or after a timeout, e.g. a silent app), so
//! all mirrors Start together instead of whenever their device happens to be
//! ready — a cold Bluetooth connection can take seconds, and without the gate
//! the wired device runs ahead by that whole setup time. After the start, every
//! mirror keeps its own backlog between the capture tap and playback: the same
//! base latency for all of them, plus how far its own delay sits above the
//! earliest device of the group, so they play the same sample at the same
//! moment offset by exactly the differences that were configured. A delay is
//! realized as silence placed ahead of the mirror's audio, and clock drift
//! between devices is absorbed by trimming the lagging device's oldest frames
//! and topping the fast device up with silence (a few milliseconds every few
//! minutes at typical crystal tolerance). The same top-up realizes a delay
//! changed while the engine is running. Hardware latency, e.g. a Bluetooth
//! codec's buffer, adds on top and is outside software control.
//!
//! This file is the module root; the code lives in the submodules below, one
//! per seam the descriptions above already draw:
//!
//! - [`format`] — the capture format, how one sample of it is stored, and the two
//!   walks that read or scale a chunk of bytes.
//! - [`metering`] — one program's running level estimate, and the units it is
//!   published in.
//! - [`mirror`] — one mirror device with its frame ring buffer.
//! - [`shared`] — the state an engine's threads hold in common, the liveness
//!   predicates built from it, and the report a live engine gives.
//! - [`registry`] — in-flight-start bookkeeping, so a stop cannot miss a start.
//! - [`manager`] — who holds a seat: registration, eviction, and the live pushes
//!   that only store an atomic.
//! - [`primary_volume`] — the session-volume axis, live.
//! - [`inventory`] — what the seated engines are serving right now (read-only).
//! - [`start`] — the landing path: build one engine and seat it.
//! - [`capture`] — the capture thread: activate the tap and feed the rings.
//! - [`render`] — a mirror's render thread: the device session and the reports.
//! - [`pump`] — the render cycle: one device period, and the park that ends it.
//! - [`mix`] — the group arithmetic: delay reference, loudness reference, gains.
//! - [`activation`] — the asynchronous process-loopback activation.
//!
//! The tuning constants stay here, together, because they are one schedule the
//! two threads read at different points of a run — and [`LATENCY_TARGET_MS`] is
//! the twin of `src/lib/types.ts`'s literal, read out of *this* file by name, so
//! it may not move. The unit tests are in `duplication/tests`, one file per topic,
//! built on the three fixtures in `tests/builders`.

use std::time::Duration;

/// Shared-mode stream buffer, in hundreds of nanoseconds (200 ms).
const STREAM_BUFFER_DURATION: i64 = 2_000_000;
/// Render threads poll the shutdown flag at this interval when idle.
const RENDER_WAIT_MS: u32 = 250;
/// Capture thread polls process liveness at this interval when silent.
const CAPTURE_WAIT_MS: u32 = 2_000;
/// Upper bound for the asynchronous process-loopback activation.
const ACTIVATION_TIMEOUT: Duration = Duration::from_secs(5);
/// Pipeline latency every mirror keeps between the capture tap and playback,
/// so all mirrors play the same sample at (approximately) the same moment.
const LATENCY_TARGET_MS: usize = 100;
/// How far a mirror's pipeline may drift past the target before its render
/// thread trims the oldest frames by the excess. Clock crystals differ by tens
/// of ppm, so this fires rarely and each trim is a few milliseconds of audio.
const TRIM_SLACK_MS: usize = 20;
/// Upper bound for waiting on the synchronized start. A silent app never fills
/// the pre-roll, and starting un-synced while silence plays is harmless.
const PRE_ROLL_TIMEOUT: Duration = Duration::from_secs(4);
/// Backstop interval for a render thread waiting for the start gate. The gate
/// wakes the mirrors when it opens; this only bounds a wakeup that never
/// arrives.
const GATE_POLL: Duration = Duration::from_millis(250);
/// How long a source must have produced nothing before its mirrors stop
/// playing and let the device idle. Well clear of the pipeline's own jitter (a
/// few periods, against a `TRIM_SLACK_MS` of slack) so a pause between two
/// packets never reads as silence.
const SOURCE_IDLE_MS: u64 = 1_500;
/// Backstop interval for a mirror parked on a quiet source. A packet wakes the
/// mirror directly (see `MirrorChannel::wake`); this only bounds how long a
/// wakeup that never arrives can hold audio back, so it is short enough that a
/// missed one is heard as a stutter rather than as a gap.
const PARK_POLL: Duration = Duration::from_millis(250);
/// How long [`DuplicationManager::stop`] waits for a start that is still in
/// flight before it refuses that start the seat instead.
///
/// The wait has to be bounded *and* have an answer: every slow step of a start
/// is a COM round trip, and a hung `AudioSrv` makes those calls never return.
/// An open-ended wait would then hold the stop's blocking-pool thread — and the
/// route the user just asked to be stopped — open for the rest of the session,
/// which is worse than the race the wait was added for. Five seconds is the
/// ceiling this module already pays for an activation that never answers
/// (`ACTIVATION_TIMEOUT`); past it the outcome is defined rather than pending.
const START_SETTLE_TIMEOUT: Duration = Duration::from_secs(5);

mod activation;
mod capture;
mod format;
mod inventory;
mod manager;
mod metering;
mod mirror;
mod mix;
mod primary_volume;
mod pump;
mod registry;
mod render;
mod shared;
mod start;

// The paths the rest of the crate names, re-exported so they keep resolving as
// `audio::duplication::X`. The submodules themselves stay private: the engine is
// one lifecycle — one seat, one capture thread, one ring per mirror, one
// session-volume claim with a promise attached — and a second route into any of
// those halves is what the wake, park and restore rules exist to make impossible.
pub(crate) use self::format::default_mix_format;
pub use self::manager::DuplicationManager;
pub use self::shared::{restore_session_volume_now, ActiveRoute};

#[cfg(test)]
mod tests;
