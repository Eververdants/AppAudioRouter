//! The landing path: build one engine and seat it.
//!
//! [`DuplicationManager::start`] is the only place an [`super::shared::EngineShared`]
//! is constructed, and it is deliberately ordered: declare the start in flight and
//! evict the incumbent in one lock step, do the slow COM work (mix format, session
//! volume), settle the seat against a newer start or a stop that stopped waiting,
//! claim the program's loudness only once the seat is settled, then spawn the
//! capture thread ([`super::capture::capture_main`]).
//!
//! Every return path before the engine lands must leave the registry clean, which
//! is [`super::registry::StartGuard`]'s job; every early exit after the claim has to
//! hand the loudness back, which is [`super::shared::EngineShared::restore_session_volume`]'s.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use log::warn;
use tauri::AppHandle;

use crate::audio::sessions;
use crate::audio::AudioError;
use crate::config::DELAY_MAX_MS;

use super::capture::capture_main;
use super::format::{default_mix_format, validate_mix_format, SampleFormat};
use super::manager::UnregisterOutcome;
use super::mirror::MirrorChannel;
use super::shared::{retire_engine, EngineShared};
use super::DuplicationManager;
use super::{LATENCY_TARGET_MS, TRIM_SLACK_MS};
use crate::audio::process_creation_time;

/// Generations handed out to engines so a stale thread can never unregister a
/// newer engine that replaced it for the same PID.
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

impl DuplicationManager {
    /// Start duplicating `pid`'s audio to `mirror_device_ids`, replacing any
    /// engine already running for the process.
    ///
    /// `primary_device_id` is the endpoint the OS plays natively; every delay is
    /// measured against it, so it has to be known by the engine (see
    /// `group_min_delay_ms`).
    ///
    /// `feed_tap_device_id` adds one more destination that is deliberately not
    /// a device of this route: the programme's audio is written into the feed
    /// carrier so another programme can record it (see `MirrorChannel::feed_tap`).
    /// A start may consist of the tap alone — that is how a programme with no
    /// device route is fed — in which case `primary_device_id` only has to be a
    /// sensible value for the delay baseline, and no session volume is claimed.
    ///
    /// The capture format is probed synchronously (a fast call); the
    /// process-loopback activation runs on the engine thread and reports
    /// failures through the `duplication-stopped` event with reason `error`.
    ///
    /// A stop that arrives while this is in flight is honored either way: the
    /// eviction below and the registration in `starting` happen in one step
    /// under the `engines` lock, and [`stop`](Self::stop) waits that registration
    /// out before it removes — or, once [`START_SETTLE_TIMEOUT`] runs out,
    /// tickets this start so the insertion below refuses the seat instead.
    pub fn start(
        &self,
        pid: u32,
        exe_name: &str,
        primary_device_id: &str,
        mirror_device_ids: Vec<String>,
        feed_tap_device_id: Option<String>,
        app: &AppHandle,
    ) -> Result<u64, AudioError> {
        // Evict any incumbent and declare this start in flight, under one
        // acquisition of `engines`. From here to the guard's drop at the end
        // of this function, a `stop` for this pid waits rather than removing
        // nothing and letting the insertion below resurrect what it stopped.
        let start_guard = self.begin_start(pid);
        if pid == 0 {
            return Err(AudioError::Api("invalid pid".to_string()));
        }
        // A tap that names the same endpoint as a device copy is dropped: the
        // device copy already plays there, and two streams into one endpoint
        // would be the programme heard twice.
        let taps: Vec<String> = feed_tap_device_id
            .filter(|id| !id.trim().is_empty() && !mirror_device_ids.contains(id))
            .into_iter()
            .collect();
        if mirror_device_ids.is_empty() && taps.is_empty() {
            return Ok(0);
        }

        let (format, block_align, sample_rate) = default_mix_format()?;
        validate_mix_format(block_align, sample_rate)?;
        let sample = SampleFormat::parse(&format);
        // Ring must hold the worst case pipeline a configuration can ask for:
        // the base latency plus the largest spread between the earliest and the
        // latest device, which two opposite extremes of the hard bound can
        // produce.
        let ring_capacity = sample_rate as usize
            * (LATENCY_TARGET_MS + 2 * DELAY_MAX_MS as usize + TRIM_SLACK_MS + 100)
            / 1000
            * block_align;
        // A feed tap rides the same ring, wake and park machinery as a device
        // copy, because it is one: the programme's audio written into another
        // endpoint. What it is *not* is a device of this route — it has no
        // share of the group's loudness and no delay to compensate, so it is
        // built with the neutral values and skipped by every group question
        // below (`group_min_delay_ms`, `group_max_volume`, `active_routes`).
        let mirrors = mirror_device_ids
            .into_iter()
            .map(|device_id| (device_id, false))
            .chain(taps.into_iter().map(|device_id| (device_id, true)))
            .map(|(device_id, feed_tap)| {
                Arc::new(MirrorChannel {
                    delay_ms: AtomicI32::new(if feed_tap {
                        0
                    } else {
                        self.delays.get(&device_id)
                    }),
                    volume_percent: AtomicU32::new(if feed_tap {
                        100
                    } else {
                        self.volumes.get(&device_id)
                    }),
                    feed_tap,
                    device_id,
                    ring: Mutex::new(VecDeque::new()),
                    capacity: ring_capacity,
                    enabled: AtomicBool::new(true),
                    wakeups: AtomicU64::new(0),
                    stream_latency_ms: AtomicU32::new(0),
                    worker: Mutex::new(None),
                })
            })
            .collect::<Vec<_>>();
        // The route's own devices, which is what the session-volume claim below
        // is about. A tap-only engine exists to feed another programme and must
        // not move this one's loudness.
        let device_copies = mirrors.iter().filter(|m| !m.feed_tap).count();

        let creation_time = process_creation_time(pid).unwrap_or(0);
        let shared = Arc::new(EngineShared {
            pid,
            exe_name: exe_name.to_string(),
            generation: NEXT_GENERATION.fetch_add(1, Ordering::Relaxed),
            creation_time,
            shutdown: AtomicBool::new(false),
            mirrors,
            capture_worker: Mutex::new(None),
            primary_device_id: primary_device_id.to_string(),
            primary_delay_ms: AtomicI32::new(self.delays.get(primary_device_id)),
            session_volume_percent: AtomicU32::new(self.primary_volumes.get(exe_name)),
            restore_volume_percent: AtomicU32::new(100),
            restore_volume: AtomicBool::new(false),
            volume_claim: Mutex::new(()),
            source_volume_percent: AtomicU32::new(self.sources.get(exe_name)),
            levels: self.levels.clone(),
            format,
            sample,
            block_align,
            sample_rate,
            latency_frames: sample_rate as usize * LATENCY_TARGET_MS / 1000,
            trim_slack_frames: sample_rate as usize * TRIM_SLACK_MS / 1000,
            sync_delays: AtomicBool::new(self.delay_sync.load(Ordering::Relaxed)),
            go: AtomicBool::new(false),
            ready_count: AtomicUsize::new(0),
            capture_wakeups: AtomicU64::new(0),
            started: Instant::now(),
            last_audio_ms: AtomicU64::new(0),
        });

        // Registering the engine is the moment two concurrent starts for the
        // same PID are reconciled, and the moment a stop that stopped waiting
        // refuses this one the seat. `stop()` ran at the top of this method, but
        // the COM work between there and here is slow enough that another
        // `start` can have slipped its own engine in: without this check the
        // loser is never told to shut down, its capture thread keeps writing
        // the program's audio to its mirrors, and the user hears the route
        // twice while its threads run until the process exits.
        let losing = {
            let mut engines = self.engines.lock().unwrap_or_else(|e| e.into_inner());
            if start_guard.stop_arrived() {
                // A `stop` gave up waiting for this start (see
                // `START_SETTLE_TIMEOUT`), so its answer already stands and this
                // one must not seat the route the user just stopped. Checked
                // under this lock, which is what makes the pair exhaustive: a
                // start that got here before the ticket was written is removed
                // by the eviction that follows the ticket. Nothing has been
                // claimed and no thread has run yet, so withdrawing is clean —
                // and the answer is the same one an empty mirror list gives:
                // `0`, no engine.
                warn!(
                "the duplication start for PID {pid} withdrew: a stop arrived while it was working"
            );
                return Ok(0);
            }
            if engines.get(&pid).map(|e| e.generation).unwrap_or(0) > shared.generation {
                // A newer engine took the seat while this start did its COM work.
                // This one never spawned a thread, so withdrawing it is clean —
                // and the caller is handed the generation of the engine that is
                // actually serving the program.
                return Ok(engines.get(&pid).map(|e| e.generation).unwrap_or(0));
            }
            // `insert` hands back whatever sat in the seat, so the eviction and
            // the registration are one atomic step. The guard ends with this
            // block: the loser is shut down outside the lock, the way `stop`
            // does it, because handing its session volume back is a round of
            // device and session enumeration and AudioSrv gets slow on a
            // Bluetooth reconnect — seconds in which every command that wants
            // `engines` would be queued behind us.
            engines.insert(pid, Arc::clone(&shared))
        };
        if let Some(losing) = losing {
            // Losing the seat is a stop like any other: shutdown, the wakes
            // that end any park, and the program's session volume back to what
            // the loser read before it claimed it.
            retire_engine(&losing);
        }

        // Claim the program's session volume for this route — only now that the
        // seat is settled, and only after the engine that held it has handed its
        // own value back. Reading the pre-route value any earlier lets a losing
        // concurrent start leave *its* write standing (it returns above without
        // a thread to restore it) and lets the winner read that write as the
        // user's own setting: the original loudness would be lost for good, and
        // `session_compensation` would divide by a percent the session is not
        // actually at, which is how a copy ends up loud by twenty times.
        //
        // What the program played at before is remembered so the route can give
        // it back on stop — a session volume that outlived the route would keep
        // the program quiet everywhere, and the volume mixer remembers the value
        // for its next launch.
        // The claim races `stop` on the other side of the same lock. Without
        // it, a stop deciding "nothing was claimed yet" could restore before
        // the promise is set, and the write below would land after it: the
        // program left at the route's loudness, with no engine and no promise,
        // and the pre-route value gone for good. Under the lock, a stop either
        // finds the promise and restores it, or this claim finds the shutdown
        // flag and never writes.
        let claim = shared
            .volume_claim
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if !shared.shutdown.load(Ordering::Relaxed) {
            if device_copies == 0 {
                // A tap-only engine has no device of ours to be the primary, so
                // the programme's loudness is none of its business: nothing is
                // claimed and nothing is written. The tap still has to carry the
                // level the programme actually produces, so the live session
                // value is read into the same field `session_compensation`
                // divides by — the feed then hears the programme as it plays,
                // untouched by a lever this engine does not own.
                if let Some(current) = sessions::get_session_volume(pid).ok().flatten() {
                    shared.session_volume_percent.store(
                        (current * 100.0).round().clamp(1.0, 100.0) as u32,
                        Ordering::Relaxed,
                    );
                }
            } else {
                if let Some(pre_route) = sessions::get_session_volume(pid).ok().flatten() {
                    shared.restore_volume_percent.store(
                        (pre_route * 100.0).round().clamp(0.0, 100.0) as u32,
                        Ordering::Relaxed,
                    );
                    shared.restore_volume.store(true, Ordering::Relaxed);
                }
                let session_percent = shared.session_volume_percent.load(Ordering::Relaxed);
                let touched =
                    sessions::set_session_volume(pid, session_percent as f32 / 100.0).unwrap_or(0);
                if touched == 0 {
                    warn!("no live session for PID {pid} — primary volume applies when it next sounds");
                }
            }
        }
        drop(claim);

        let generation = shared.generation;
        let app = app.clone();
        let thread_shared = Arc::clone(&shared);
        if let Err(e) = std::thread::Builder::new()
            .name(format!("aar-dup-{pid}"))
            .spawn(move || capture_main(thread_shared, app))
        {
            // The engine never started, so no thread will unregister it; drop
            // the entry here or `active_routes` would report it forever.
            let outcome = self.unregister(pid, generation);
            // The predecessor this start evicted skipped its own level cleanup
            // on the promise that this engine publishes under the same key — a
            // promise the thread that never ran cannot keep. Unless a successor
            // already holds the seat: it publishes under that same key, and
            // forgetting here would drop the reading it just wrote.
            if !matches!(outcome, UnregisterOutcome::Replaced) {
                shared.levels.forget(&shared.exe_name, pid);
            }
            // And give the loudness back: the thread that owns an engine's
            // teardown is the only thing that would have, and it never ran, so
            // the program would stay quiet on every path — with the volume
            // mixer remembering our value for its next launch.
            shared.restore_session_volume();
            return Err(AudioError::Api(format!("spawn capture thread failed: {e}")));
        }
        Ok(generation)
    }
}
