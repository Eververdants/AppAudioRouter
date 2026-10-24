//! The running level estimate of one program's audio.
//!
//! One [`LevelTracker`] per engine, folded from the capture thread's packets and
//! published to the shared table on a schedule. Two numbers, because the
//! alignment needs both: a smoothed level to bring everything to, and a worst
//! case that the gain it computes has to stay under.
//!
//! [`measure_into`] is the entry point the capture loop calls, and the one that
//! fixes the *units*: the tap sits behind the program's session volume, so the
//! factor [`super::mix::session_compensation`] divides back out of a mirror's
//! gain is divided *into* the estimate here, leaving it in what the program
//! produced rather than in what one device was handed.

use std::time::{Duration, Instant};

use crate::audio::levels::SourceLevels;

use super::format::measure_chunk;
use super::mix::session_compensation;
use super::shared::EngineShared;

/// Smoothing window for a program's level estimate.
///
/// Short enough to describe what is playing now rather than everything since
/// the engine started, long enough that the estimate does not swing packet to
/// packet.
pub(super) const LEVEL_WINDOW_MS: f32 = 300.0;
/// Release time of the peak estimate: how long the loudest sample seen keeps
/// its influence.
///
/// A gain is bounded by this peak, so it has to outlive the short peaks of
/// ordinary program material without pinning the estimate to one loud moment
/// for the rest of the session. Long enough to survive a transient, short
/// enough that a program which has genuinely quietened down stops being held
/// back by a moment from a minute ago.
pub(super) const PEAK_RELEASE_MS: f32 = 2_000.0;
/// How often the running estimate is published. The level cannot change
/// meaningfully faster than this, and publishing per packet would take the
/// shared table's lock a hundred times a second per engine.
const LEVEL_PUBLISH_MS: u64 = 100;

/// The running level estimate of one program's audio.
///
/// Owned by that engine's capture thread, which is its only writer, and folded
/// from the packets as they arrive. Two numbers, because an alignment needs
/// both: a stable level to bring everything to, and a worst case that the gain
/// it computes has to stay under.
#[derive(Default)]
pub(super) struct LevelTracker {
    /// Mean square of the samples, smoothed over `LEVEL_WINDOW_MS`.
    rms_sq: f32,
    /// Loudest sample seen, fading over `PEAK_RELEASE_MS`.
    pub(super) peak: f32,
    /// Milliseconds folded so far, which is what sets the smoothing weight.
    elapsed_ms: f32,
    /// When the estimate was last published, so the shared table is written on
    /// a schedule rather than per packet.
    published_at: Option<Instant>,
}

impl LevelTracker {
    /// Fold one chunk in. `mean_sq` and `peak` are fractions of full scale.
    pub(super) fn fold(&mut self, mean_sq: f32, peak: f32, chunk_ms: f32) {
        // The first chunk seeds the average instead of fading up from silence,
        // which would understate a program that has only just started playing.
        let alpha = if self.elapsed_ms == 0.0 {
            1.0
        } else {
            (chunk_ms / LEVEL_WINDOW_MS).clamp(0.0, 1.0)
        };
        self.rms_sq += (mean_sq - self.rms_sq) * alpha;
        let decay = (1.0 - chunk_ms / PEAK_RELEASE_MS).clamp(0.0, 1.0);
        self.peak = (self.peak * decay).max(peak);
        self.elapsed_ms += chunk_ms;
    }

    /// The smoothed level, as a fraction of full scale.
    pub(super) fn rms(&self) -> f32 {
        self.rms_sq.max(0.0).sqrt()
    }

    /// Publish the estimate if `LEVEL_PUBLISH_MS` has passed since the last one.
    fn publish_if_due(&mut self, levels: &SourceLevels, exe_name: &str, pid: u32) {
        let due = self
            .published_at
            .is_none_or(|at| at.elapsed() >= Duration::from_millis(LEVEL_PUBLISH_MS));
        if !due {
            return;
        }
        self.published_at = Some(Instant::now());
        levels.record(exe_name, pid, self.rms(), self.peak);
    }
}

/// Fold one captured chunk into the engine's level estimate, in the units the
/// program produced.
///
/// The tap sits behind the session volume (see `session_compensation`), so what
/// arrives here is the program's audio at the level the *primary* plays it — and
/// the mirrors divide that same factor straight back out again. Publishing the
/// estimate as the program produced it is what keeps the level alignment honest:
/// read behind the session volume, two programmes with different primary volumes
/// measure an exact session-ratio apart and the gains "aligning" them would be
/// wrong by that same ratio on every device they are copied to. The factor
/// scales the mean square by its square and the peak by itself.
pub(super) fn measure_into(
    level: &mut LevelTracker,
    shared: &EngineShared,
    chunk: &[u8],
    frames: u32,
) {
    let Some((mean_sq, peak)) = measure_chunk(chunk, shared.sample) else {
        return;
    };
    let produced = f64::from(session_compensation(shared));
    let chunk_ms = frames as f32 * 1000.0 / shared.sample_rate.max(1) as f32;
    level.fold(
        (f64::from(mean_sq) * produced * produced) as f32,
        (f64::from(peak) * produced) as f32,
        chunk_ms,
    );
    level.publish_if_due(&shared.levels, &shared.exe_name, shared.pid);
}
