//! Core Audio change notifications.
//!
//! Pushes `audio-changed` events at the frontend so the device and process
//! lists follow reality — a headset plugged in, an app that starts or stops
//! playing — without a polling timer touching the audio engine while idle.
//!
//! Every COM pointer in this module belongs to **one** thread. [`start`] spawns
//! a dedicated MTA thread that registers the callbacks and then owns them for
//! the rest of the process. windows-rs interfaces are neither `Send` nor `Sync`,
//! so confining them to one thread is what lets this module avoid
//! `unsafe impl Send` workarounds entirely: the callbacks, which Windows invokes
//! on its own RPC threads, do nothing but drop a message in a channel.
//!
//! This file is the module root; the code lives in the submodules below, one
//! per seam the descriptions above already draw:
//!
//! - [`callbacks`] — the three COM callback objects (endpoint, session-created,
//!   session-state) plus the liveness ledger they write and the record of a
//!   registered watcher. Nothing here reaches a COM pointer across a thread.
//! - [`absence`] — the ledger that keeps a walk which could not name an endpoint
//!   from reading that silence as removal, the exact-id probe behind it, and the
//!   bounded deferral for a question the audio service cannot answer.
//! - [`walk`] — the enumeration helpers: the active render endpoints, one
//!   device's session manager and session list, the ids they are keyed by, and
//!   the witness a synchronisation pass builds from them.
//! - [`engine`] — one synchronisation pass over the graph: wire watchers onto
//!   what is there, ask the service about what is missing, prune what is gone.
//! - [`thread`] — [`start`] and its thread body: register, drain the callbacks
//!   into one batch, re-synchronise, emit, and hand the registrations back on
//!   the way out.
//!
//! [`AUDIO_CHANGED_EVENT`], [`SESSION_ACTIVITY_EVENT`], [`AudioChanged`] and
//! [`SessionActivity`] are the surface the rest of the crate names, kept here so
//! those paths do not move; tests stay with the code they cover, in these files.

mod absence;
mod callbacks;
mod engine;
mod thread;
mod walk;

use serde::Serialize;

// The thread's entry point, re-exported so it keeps resolving as
// `audio::notifications::start`. The submodules themselves stay private: the
// COM pointers are owned by the one thread `start` spawns, and a second route
// into them is exactly what this module's design forbids.
pub use self::thread::start;

/// Event carrying an [`AudioChanged`] payload.
pub const AUDIO_CHANGED_EVENT: &str = "audio-changed";

/// Event carrying a [`SessionActivity`] payload.
pub const SESSION_ACTIVITY_EVENT: &str = "session-activity";

/// Which half of the frontend is stale.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioChanged {
    /// The endpoint list, or the system default among them, moved.
    pub devices: bool,
    /// A session appeared or expired.
    pub sessions: bool,
}

/// One process began or stopped rendering audio.
///
/// Emitted on its own channel rather than folded into [`AudioChanged`]: a
/// session going quiet is not a list change (the session survives), and the
/// frontend uses this to animate the routes of the programs that are actually
/// sounding — which wants to arrive now, not at the end of a re-enumeration.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionActivity {
    /// The process whose audio state moved.
    pub pid: u32,
    /// Whether it is rendering audio now.
    pub active: bool,
}

/// Work item handed from a COM callback thread back to the owner thread.
pub(super) enum Msg {
    /// An endpoint changed: its device is new, gone, or the new default.
    Endpoint,
    /// A session appeared on a device this thread watches.
    SessionCreated,
    /// A watched session expired (the app stopped playing or exited).
    SessionExpired,
    /// A watched session began or stopped rendering audio.
    SessionState { pid: u32, active: bool },
}
