//! The session-volume axis, live.
//!
//! The program's primary (session) volume is the one loudness this app writes
//! *through* Windows rather than in software, so touching it is a claim with a
//! promise attached: [`DuplicationManager::update_primary_volume`] pushes a new
//! value onto every engine of that program and onto its live sessions, serialized
//! against that engine's own claim and restore ([`super::shared::EngineShared::volume_claim`]).
//! [`DuplicationManager::take_pending_session_volume_restores`] is what app exit
//! collects on the way out — with the shutdown sweep's ticketing in front of it,
//! because a sweep that cannot wait has to refuse instead.
//!
//! The device share (`update_volume` above) and this axis are different numbers on
//! purpose; nothing here may reach a session volume except through this path.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use log::warn;

use crate::audio::sessions;

use super::shared::{wake_capture, EngineShared};
use super::DuplicationManager;

impl DuplicationManager {
    /// Push a program's primary volume — its session volume — to every engine
    /// running for it, and write it onto the live sessions so it takes effect
    /// now. Matched by executable name, the same ownership rule the level
    /// uses; persisting the value is the caller's job (see
    /// `PrimaryVolumeConfig`).
    ///
    /// A program with no live session is left as it is: the value is stored,
    /// and the next engine this program gets applies it at start.
    ///
    /// Each engine's write is serialized against that engine's own claim/restore
    /// (see `volume_claim`), for the same reason the claim is: a `stop` landing
    /// mid-write hands the pre-route loudness back, and unless the two are kept
    /// apart the restore can land *first* — leaving the program at the route's
    /// value with no engine left to undo it, and the mixer remembering that
    /// value for the program's next launch.
    pub fn update_primary_volume(&self, exe_name: &str, percent: u32) {
        // The engines are collected under the lock and written to outside of
        // it: `set_session_volume` is a full device and session enumeration,
        // and no start, stop or route read should queue behind one per engine.
        let targets: Vec<Arc<EngineShared>> = self
            .engines
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter(|engine| engine.exe_name == exe_name)
            .cloned()
            .collect();
        for engine in targets {
            engine
                .session_volume_percent
                .store(percent, Ordering::Relaxed);
            let _claim = engine
                .volume_claim
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            // The engine is on its way down and its restore owns the promise:
            // writing here would stand after the value it hands back. The
            // stored percentage is what the next engine for this program
            // applies, so the user's number is not lost by skipping the write.
            if engine.shutdown.load(Ordering::Relaxed) {
                continue;
            }
            match sessions::set_session_volume(engine.pid, percent as f32 / 100.0) {
                Ok(0) => log::warn!(
                    "no live session for PID {} — primary volume stored for its next route",
                    engine.pid
                ),
                Ok(_) => {}
                Err(e) => log::warn!("writing primary volume onto PID {} failed: {e}", engine.pid),
            }
        }
    }

    /// Give every engine's program its pre-route session volume back.
    ///
    /// Called on app exit: the route ends with the process, and a session
    /// volume left behind would keep the program quietly playing everywhere —
    /// the volume mixer remembers the value for its next launch.
    ///
    /// Returns the loudness every running engine still owes, as `(pid, percent)`,
    /// after taking each engine's promise.
    /// Quitting collects these on the way out and hands the writes to the exit
    /// worker, which cannot hold a `DuplicationManager` — and taking them is what
    /// keeps an engine's own teardown from writing the same value a second time.
    pub fn take_pending_session_volume_restores(&self) -> Vec<(u32, u32)> {
        // Starts in flight first, and without waiting: this runs while the app is
        // closing, so it cannot afford the bounded wait `stop` uses, and an engine
        // that seats after the sweep below would claim a session volume that
        // nobody is left to hand back — the mixer then remembers our route's
        // value for the program's next launch. Ticketing refuses them the seat.
        let refused = self.starting.ticket_all();
        if refused > 0 {
            warn!("{refused} duplication start(s) were refused the seat by the shutdown sweep");
        }
        // Same shape as `update_primary_volume`: snapshot under the lock, do
        // the session writes outside of it.
        let engines: Vec<Arc<EngineShared>> = self
            .engines
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect();
        let mut pending = Vec::new();
        for engine in &engines {
            // The claim lock again, for the same reason `update_primary_volume`
            // takes it: this promise is what the exit worker hands back, and a
            // primary-volume write that landed after it would leave the mixer
            // remembering our route's value for the program's next launch with
            // no engine left to undo it. The engine goes down with the app, so
            // also raise its flag here — a write deciding under this lock then
            // finds `shutdown` set and skips, and the wakes let a parked
            // mirror or a held capture thread wind down promptly.
            let _claim = engine
                .volume_claim
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            engine.shutdown.store(true, Ordering::Relaxed);
            for mirror in &engine.mirrors {
                mirror.wake();
            }
            wake_capture(engine);
            if let Some(promise) = engine.take_restore_promise() {
                pending.push(promise);
            }
        }
        pending
    }
}
