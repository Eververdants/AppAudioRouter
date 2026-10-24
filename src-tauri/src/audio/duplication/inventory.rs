//! What the seated engines are serving right now — read-only.
//!
//! The queries the commands and the sweep ask: which programs are routed
//! ([`DuplicationManager::routed_exe_names`]), what one pid is playing to
//! ([`DuplicationManager::device_targets_of`], [`DuplicationManager::feed_tap_of`]),
//! whether an exe is duplicated by another engine
//! ([`DuplicationManager::exe_duplicated_elsewhere`]), and the report the frontend
//! renders ([`DuplicationManager::active_routes`], with the latency readings from
//! [`super::mix::total_latency_ms`] in the same order as the device list).
//!
//! Both lists keep the same two rules: a feed tap is not a device of the route, and
//! an engine that carries only a tap is not a route at all.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use super::mirror::MirrorChannel;
use super::mix::total_latency_ms;
use super::shared::ActiveRoute;
use super::DuplicationManager;

impl DuplicationManager {
    /// The executables a live engine is playing to at least one *device* right
    /// now, each named once and sorted.
    ///
    /// One program can hold several engines (a browser holds one per window's
    /// session), and a level belongs to the program, so the caller gets programs
    /// rather than PIDs.
    ///
    /// An engine that only carries a feed tap is not routing anything: no device
    /// of the board is fed by it, its programme keeps playing wherever Windows
    /// had it, and it holds no per-app output assignment of ours. Counting it as
    /// routed would make the settings reset skip a programme whose endpoints are
    /// exactly what that reset is for, and would pull a programme the user never
    /// routed into the level alignment.
    pub fn routed_exe_names(&self) -> Vec<String> {
        let engines = self.engines.lock().unwrap_or_else(|e| e.into_inner());
        let mut names: Vec<String> = engines
            .values()
            .filter(|engine| engine.mirrors.iter().any(|m| !m.feed_tap))
            .map(|engine| engine.exe_name.clone())
            .collect();
        names.sort();
        names.dedup();
        names
    }

    /// The executable name of the engine running for `pid`, if one is.
    pub fn exe_name_of(&self, pid: u32) -> Option<String> {
        self.engines
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&pid)
            .map(|e| e.exe_name.clone())
    }

    /// Whether an engine other than `pid`'s is duplicating the same
    /// executable right now.
    ///
    /// The per-app endpoint assignment Windows persists is stored per
    /// executable (see the module docs of `routing.rs`), so anything that
    /// releases it through one PID takes it away from every other PID of the
    /// same program — including one whose route is still live.
    pub fn exe_duplicated_elsewhere(&self, pid: u32) -> bool {
        let engines = self.engines.lock().unwrap_or_else(|e| e.into_inner());
        let Some(engine) = engines.get(&pid) else {
            return false;
        };
        let exe = engine.exe_name.as_str();
        engines.values().any(|e| e.pid != pid && e.exe_name.eq(exe))
    }

    /// The ordered devices `pid`'s engine is serving right now, if one runs:
    /// the primary the OS plays itself, then the copies. The feed tap is not
    /// part of the answer — it is not a device of the route.
    ///
    /// Used when an engine has to be restarted with the same route (a feed tap
    /// added or taken off): the mirror list is fixed for the life of an engine,
    /// and reading it back is what keeps the restart from inventing a route.
    pub fn device_targets_of(&self, pid: u32) -> Option<(String, Vec<String>)> {
        let engines = self.engines.lock().unwrap_or_else(|e| e.into_inner());
        let engine = engines.get(&pid)?;
        Some((
            engine.primary_device_id.clone(),
            engine
                .mirrors
                .iter()
                .filter(|m| !m.feed_tap)
                .map(|m| m.device_id.clone())
                .collect(),
        ))
    }

    /// The endpoint `pid`'s feed tap writes into, when its engine carries one.
    ///
    /// Asked before a feed change restarts an engine: the mirror list is fixed
    /// for its lifetime, so a tap that is already the right one must not cost the
    /// route a gap just because a second feed was added.
    pub fn feed_tap_of(&self, pid: u32) -> Option<String> {
        let engines = self.engines.lock().unwrap_or_else(|e| e.into_inner());
        engines
            .get(&pid)?
            .mirrors
            .iter()
            .find(|m| m.feed_tap)
            .map(|m| m.device_id.clone())
    }

    /// Live engines with the exact ordered device list they are serving.
    ///
    /// An engine that owns only a feed tap is not a route and is left out: no
    /// device of the board is being played by it, and reporting it would put a
    /// badge on a programme the user never routed — or, worse, would make the
    /// board believe a single-device route is engine-backed and retire its badge
    /// the moment the feed comes off.
    pub fn active_routes(&self) -> Vec<ActiveRoute> {
        let engines = self.engines.lock().unwrap_or_else(|e| e.into_inner());
        let mut routes: Vec<ActiveRoute> = engines
            .values()
            .filter_map(|engine| {
                // Only the mirrors that are still in service. A mirror that
                // failed to open, or that errored later, is not a route target:
                // reporting it as one puts its badge, its success dot and its
                // pulse ring back on the stage for a device that is producing
                // nothing, and hides the one report the user got about it. The
                // frontend cannot recover this on its own — the failure arrives
                // as an event, and it is this list that would overwrite it.
                //
                // The feed tap is not a device of this route at all: it is the
                // wire into another programme (see `MirrorChannel::feed_tap`),
                // and it never appears in a device list.
                let mirrors: Vec<&Arc<MirrorChannel>> = engine
                    .mirrors
                    .iter()
                    .filter(|m| !m.feed_tap && m.enabled.load(Ordering::Relaxed))
                    .collect();
                if mirrors.is_empty() {
                    return None;
                }
                Some(ActiveRoute {
                    pid: engine.pid,
                    generation: engine.generation,
                    device_ids: std::iter::once(engine.primary_device_id.clone())
                        .chain(mirrors.iter().map(|m| m.device_id.clone()))
                        .collect(),
                    // Same order, same length: the primary heads the list and is
                    // the one entry this engine cannot answer for.
                    latency_ms: std::iter::once(None)
                        .chain(mirrors.iter().map(|m| total_latency_ms(engine, m)))
                        .collect(),
                })
            })
            .collect();
        routes.sort_by_key(|route| route.pid);
        routes
    }
}
