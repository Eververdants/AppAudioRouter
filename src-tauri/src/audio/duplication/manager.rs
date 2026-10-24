//! The manager as Tauri state: which engines hold a seat, and how one is taken.
//!
//! [`DuplicationManager`] is one map of pid → engine plus the persisted per-device
//! and per-program values an engine is built from. This file is the ownership
//! half: [`DuplicationManager::new`], the live pushes that only store an atomic
//! ([`DuplicationManager::update_delay`], [`DuplicationManager::update_volume`],
//! [`DuplicationManager::update_source_volume`]), and the four steps that decide
//! who is seated — [`DuplicationManager::stop`], [`DuplicationManager::evict`],
//! [`DuplicationManager::begin_start`] and [`DuplicationManager::unregister`].
//!
//! The lock order lives here and in [`super::registry`]: `engines` before
//! `starting`, everywhere, and a `stop` sleeping in the wait holds nothing at all.
//! Landing an engine is [`super::start`]; reading what is seated is
//! [`super::inventory`]; the session-volume axis is [`super::primary_volume`].

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use log::warn;

use crate::audio::levels::SourceLevels;
use crate::config::{DelayConfig, PrimaryVolumeConfig, SourceVolumeConfig, VolumeConfig};

use super::registry::{StartGuard, StartRegistry};
use super::shared::{retire_engine, EngineShared};
use super::START_SETTLE_TIMEOUT;

/// Per-process duplication engines, managed as Tauri state.
pub struct DuplicationManager {
    pub(super) engines: Mutex<HashMap<u32, Arc<EngineShared>>>,
    /// Starts that are between their eviction and their insertion (see
    /// `StartRegistry`); `stop` waits this out (and tickets it when the wait
    /// runs out), `begin_start` fills it.
    pub(super) starting: StartRegistry,
    /// Persisted per-device delay compensation values.
    pub(super) delays: Arc<DelayConfig>,
    /// Persisted per-device volume values.
    pub(super) volumes: Arc<VolumeConfig>,
    /// Persisted per-program level values.
    pub(super) sources: Arc<SourceVolumeConfig>,
    /// Persisted per-program primary (session) volume values.
    pub(super) primary_volumes: Arc<PrimaryVolumeConfig>,
    /// Shared per-program level measurements.
    pub(super) levels: Arc<SourceLevels>,
    /// Whether delay compensation is enabled. Always on: the compensation is
    /// the whole point of the feature, so it has no switch of its own.
    pub(super) delay_sync: AtomicBool,
}

impl DuplicationManager {
    /// Create the manager, reading initial per-device values from `delays` and
    /// `volumes`.
    pub fn new(
        delays: Arc<DelayConfig>,
        volumes: Arc<VolumeConfig>,
        sources: Arc<SourceVolumeConfig>,
        primary_volumes: Arc<PrimaryVolumeConfig>,
        levels: Arc<SourceLevels>,
    ) -> Self {
        Self {
            engines: Mutex::new(HashMap::new()),
            starting: StartRegistry::default(),
            delays,
            volumes,
            sources,
            primary_volumes,
            levels,
            delay_sync: AtomicBool::new(true),
        }
    }

    /// Push a new delay value to any live engine using `device_id`, regardless
    /// of whether the device is a mirror or the primary one. Persisting the
    /// value is the caller's job (see `DelayConfig`).
    pub fn update_delay(&self, device_id: &str, delay_ms: i32) {
        for engine in self
            .engines
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            if engine.primary_device_id == device_id {
                engine.primary_delay_ms.store(delay_ms, Ordering::Relaxed);
            }
            for mirror in &engine.mirrors {
                if mirror.device_id == device_id {
                    mirror.delay_ms.store(delay_ms, Ordering::Relaxed);
                }
            }
        }
    }

    /// Push a new volume value to any live engine using `device_id` as a
    /// mirror. Persisting the value is the caller's job (see `VolumeConfig`).
    ///
    /// The primary device takes no share anymore: its loudness is the
    /// program's session volume (`update_primary_volume`), which is a
    /// property of the program rather than of the device. A value stored for
    /// a device applies whenever that device plays as a copy — including for
    /// an engine where it is the primary of one route and a mirror of
    /// another.
    pub fn update_volume(&self, device_id: &str, percent: u32) {
        for engine in self
            .engines
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            for mirror in &engine.mirrors {
                if mirror.device_id == device_id {
                    mirror.volume_percent.store(percent, Ordering::Relaxed);
                }
            }
        }
    }

    /// Push a program's level to every engine running for it.
    ///
    /// Matched by executable name rather than by PID, the same ownership rule
    /// the routing assignments use: one program can hold several sessions, and
    /// its level belongs to the program.
    pub fn update_source_volume(&self, exe_name: &str, percent: u32) {
        for engine in self
            .engines
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
        {
            if engine.exe_name == exe_name {
                engine
                    .source_volume_percent
                    .store(percent, Ordering::Relaxed);
            }
        }
    }

    /// Signal the engine for `pid` to stop. Threads clean up asynchronously.
    ///
    /// A start still in flight for `pid` lands first: this waits for it, then
    /// removes what it inserted. Returning before that would let the stop
    /// remove nothing while an engine was mid-COM-work, and the late insertion
    /// would play a stopped route's audio to mirrors the board no longer shows.
    ///
    /// The wait is bounded by [`START_SETTLE_TIMEOUT`], because every slow step
    /// of a start is a COM round trip and a wedged audio service never answers:
    /// an open-ended wait here would hang the caller's command — and the route
    /// it is trying to take down — for the rest of the session. Timing out has a
    /// defined outcome rather than a pending one: the starts still in flight are
    /// ticketed (they refuse the seat at their insertion) and anything that
    /// landed before the ticket is removed by the eviction below. Either way,
    /// once this returns no engine is or will be seated for `pid`.
    pub fn stop(&self, pid: u32) {
        if !self.starting.wait_for_quiet(pid, START_SETTLE_TIMEOUT) {
            warn!(
                "a duplication start for PID {pid} has not settled in {:?}; it is refused the \
                 seat rather than waited on",
                START_SETTLE_TIMEOUT
            );
        }
        self.evict(pid);
    }

    /// Remove `pid`'s engine, if one is seated, and take it down — without
    /// waiting on an in-flight start. Public callers want [`stop`](Self::stop);
    /// `begin_start` is the only caller that must not wait (it *is* the start).
    fn evict(&self, pid: u32) {
        let engine = self
            .engines
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&pid);
        if let Some(shared) = engine {
            retire_engine(&shared);
        }
    }

    /// Evict `pid`'s incumbent and register this start in one step, so a stop
    /// that arrives from here on waits for this start to land instead of
    /// removing nothing beneath it. The incumbent is retired outside the lock,
    /// the way `stop` does it: handing its session volume back is a round of
    /// device and session enumeration, and AudioSrv gets slow on a Bluetooth
    /// reconnect — seconds in which every command that wants `engines` would
    /// be queued behind us.
    pub(super) fn begin_start(&self, pid: u32) -> StartGuard<'_> {
        let (incumbent, sequence) = {
            let mut engines = self.engines.lock().unwrap_or_else(|e| e.into_inner());
            // Lock order: `engines` before `starting`, everywhere. Every
            // `StartRegistry` call either holds `engines` first (`begin` here and
            // `should_withdraw` at the insertion, both short and COM-free) or
            // takes only its own lock and never reaches for `engines`
            // (`clear`, `wait_for_quiet`, `ticket_all`) — and while a `stop`
            // sleeps in `wait_for_quiet` it holds nothing at all, which is what
            // lets the start it waits on finish and clear its own count. The
            // teardown chain stays on the other side of that rule: `retire_engine`
            // → `MirrorChannel::wake` / `wake_capture` → `restore_session_volume`
            // takes only a worker lock, the capture worker's lock and
            // `volume_claim`, and is reached from `evict`, `begin_start` and the
            // insertion's loser only once `engines` has been released;
            // `hold_after_lost_copies` takes the worker's lock alone.
            // `volume_claim` is a leaf: it nests no lock, only COM.
            let sequence = self.starting.begin(pid);
            (engines.remove(&pid), sequence)
        };
        if let Some(shared) = incumbent {
            retire_engine(&shared);
        }
        StartGuard {
            registry: &self.starting,
            pid,
            sequence,
        }
    }

    /// Remove `pid`'s engine unless a newer engine replaced it. Called by the
    /// engine's own capture thread on exit; [`UnregisterOutcome::Current`] is
    /// what makes its own teardown steps (the session-volume restore) safe to
    /// run.
    pub(super) fn unregister(&self, pid: u32, generation: u64) -> UnregisterOutcome {
        let mut engines = self.engines.lock().unwrap_or_else(|e| e.into_inner());
        match engines.get(&pid).map(|e| e.generation) {
            Some(g) if g == generation => {
                engines.remove(&pid);
                UnregisterOutcome::Current
            }
            Some(_) => UnregisterOutcome::Replaced,
            None => UnregisterOutcome::Empty,
        }
    }
}

/// What [`DuplicationManager::unregister`] found in the seat.
pub(super) enum UnregisterOutcome {
    /// This engine was still the one serving `pid`; it left the map with this
    /// call.
    Current,
    /// A newer engine serves `pid` now.
    Replaced,
    /// No engine serves `pid` — `stop` already removed this one.
    Empty,
}
