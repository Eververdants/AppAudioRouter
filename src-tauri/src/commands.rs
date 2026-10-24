//! Tauri command handlers.
//!
//! The whole IPC surface of the app, split by what a caller is asking for:
//! `discovery` (what is out there — devices, sessions, window apps, icons),
//! `routes` (apply a route, stop one, and the live engines the board reads),
//! `release` (hand back per-app endpoint assignments this run is not using),
//! `feeds` (send one program's output into another's input, and the carrier pair
//! that carries them), `taps` (the feed tap inside a duplication engine, shared
//! by the route and the feed paths), `tuning` (device delays and shares, program
//! levels and session volumes), `calibration` (the delay wizard's test tone),
//! `memory` (remembered routes, and the "start clean" half of the tour),
//! `shell` (tray, autostart, startup notice, the allowlisted pages) and
//! `identity` / `outcomes` (the executable name every program-side record is
//! keyed by, and what a command leaves to report).
//!
//! What a command is *called* on the wire does not move with it: Tauri takes the
//! name from the function, and `main.rs`'s `generate_handler!` is the only
//! registration, so the paths there follow this tree while the names do not
//! change. `src/lib/invoke.test.ts` scans every `.rs` under `src-tauri/src` for
//! `#[tauri::command]` rather than one file, so a command cannot be hidden from
//! that check by moving it.
//!
//! The rules the split is arranged around are the ones the whole module already
//! followed: every program-side key is the executable name; a write of a per-app
//! endpoint is booked in `PinnedRoutes` and handed back on stop, exit, sweep or
//! reset; the reset reaches every assignment no live route holds because the
//! service keeps no author field; session volume is only ever written through the
//! engine, and only for a routed program.
//!
//! Bodies were moved as they stood, so behaviour is the pre-split one — only the
//! `mod` paths and the visibility of the helpers shared across them changed.

pub(crate) mod calibration;
pub(crate) mod discovery;
pub(crate) mod feeds;
pub(crate) mod identity;
pub(crate) mod memory;
pub(crate) mod outcomes;
pub(crate) mod release;
pub(crate) mod routes;
pub(crate) mod shell;
pub(crate) mod taps;
pub(crate) mod tuning;

// The shapes several commands report with, declared once in `outcomes` and
// re-exported here so a submodule names them as `super::Xxx` — the way `config`
// re-exports the bounds its stores share.
pub use self::outcomes::{AlignOutcome, FeedBlockReason, FeedOutcome, ResetOutcome, StopOutcome};
