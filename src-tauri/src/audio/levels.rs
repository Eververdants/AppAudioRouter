//! What each program's audio is measuring at.
//!
//! One program's level is meaningless on its own — it only means something
//! next to another program's. So the measurements live in one table that every
//! engine writes to and anything can read, rather than inside the engine that
//! happened to take them.
//!
//! The table holds numbers and nothing else. Reading the samples belongs to the
//! engine that already has them (`audio::duplication`), which is where the
//! sample format is known.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::config::SOURCE_VOLUME_MAX;

/// One program's most recent measurement.
#[derive(Clone, Copy, Debug)]
pub struct SourceLevel {
    /// Level over roughly the engine's smoothing window, as a fraction of full
    /// scale. The stable number an alignment is computed from.
    pub rms: f32,
    /// Loudest sample seen while the peak still holds, as a fraction of full
    /// scale. The worst case a gain has to stay under so that amplifying a
    /// program cannot clip it.
    pub peak: f32,
    /// When this was published.
    pub at: Instant,
}

/// How old a reading may be before it stops describing anything.
///
/// A process loopback only delivers packets while the program is making a
/// sound, so a program that has gone quiet keeps whatever it last measured.
/// Past this age the reading means "not playing", which is a different thing
/// from "playing quietly" and must not be aligned against.
pub const LEVEL_MAX_AGE: Duration = Duration::from_millis(1_000);

/// Level measurements for every program an engine is duplicating.
///
/// Written by each engine's capture thread and read by the commands and by the
/// level alignment. Interior mutability, like the config files, because it is
/// reached through shared state.
#[derive(Default)]
pub struct SourceLevels {
    levels: Mutex<HashMap<String, SourceLevel>>,
}

impl SourceLevels {
    /// An empty table.
    pub fn new() -> Self {
        Self::default()
    }

    /// Record the current estimate for one program, replacing the last one.
    pub fn record(&self, exe_name: &str, rms: f32, peak: f32) {
        self.levels
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                exe_name.to_string(),
                SourceLevel {
                    rms,
                    peak,
                    at: Instant::now(),
                },
            );
    }

    /// Every reading still describing something, as `(exe_name, level)` pairs
    /// sorted by name so the order a caller sees does not shift under it.
    ///
    /// Readings that have gone stale are dropped here rather than removed on the
    /// way in: a program that pauses and resumes is the same program, and
    /// forgetting its number would only throw away the estimate that is about to
    /// be refreshed anyway.
    pub fn fresh_all(&self, max_age: Duration) -> Vec<(String, SourceLevel)> {
        let levels = self.levels.lock().unwrap_or_else(|e| e.into_inner());
        let mut fresh: Vec<(String, SourceLevel)> = levels
            .iter()
            .filter(|(_, level)| level.at.elapsed() < max_age)
            .map(|(name, level)| (name.clone(), *level))
            .collect();
        fresh.sort_by(|a, b| a.0.cmp(&b.0));
        fresh
    }
}

/// How far below the group's loudest program every other program is brought.
///
/// Several programs aligned to the same level add up at the device, and that sum
/// belongs to the Windows mixer where this side cannot see it. So this is a
/// courtesy margin rather than a guarantee: with many programs playing at once,
/// the device volume is still the control that has to move.
pub const ALIGN_HEADROOM: f32 = 0.7;

/// What each program in a group needs to be as loud as the others, as
/// `(exe_name, gain)`, where a gain of 1.0 leaves that program's audio alone.
///
/// Empty when there is nothing to align: fewer than two programs are playing
/// (one program cannot be aligned against itself), or every one of them is
/// silent, in which case there is no ratio to take and dividing by it would
/// produce a gain that means nothing.
///
/// Each gain is bounded twice — once by the ceiling a program's own level may
/// reach, and once by that program's measured peak. The second bound is what
/// makes amplification safe: a gain of `1 / peak` puts a program's loudest
/// sample at full scale and can put nothing past it.
pub fn aligned_gains(playing: &[(String, SourceLevel)]) -> Vec<(String, f32)> {
    if playing.len() < 2 {
        return Vec::new();
    }
    let loudest = playing
        .iter()
        .map(|(_, level)| level.rms)
        .fold(0.0f32, f32::max);
    let target = loudest * ALIGN_HEADROOM;
    if target <= 0.0 {
        return Vec::new();
    }
    let ceiling = SOURCE_VOLUME_MAX as f32 / 100.0;
    playing
        .iter()
        .map(|(exe_name, level)| {
            // A program whose peak was never measured is only bounded by the
            // ceiling: guessing a peak would either clip it or hold it back for
            // no reason.
            let peak_bound = if level.peak > 0.0 {
                1.0 / level.peak
            } else {
                ceiling
            };
            let bound = ceiling.min(peak_bound);
            let gain = (target / level.rms.max(f32::MIN_POSITIVE)).clamp(0.0, bound);
            (exe_name.clone(), gain)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn level(rms: f32, peak: f32) -> SourceLevel {
        SourceLevel {
            rms,
            peak,
            at: Instant::now(),
        }
    }

    #[test]
    fn a_reading_is_fresh_until_it_ages_out() {
        let levels = SourceLevels::new();
        levels.record("game.exe", 0.25, 0.5);

        let fresh = levels.fresh_all(Duration::from_secs(60));
        assert_eq!(fresh.len(), 1);
        assert_eq!(fresh[0].0, "game.exe");
        assert_eq!(fresh[0].1.rms, 0.25);
        assert_eq!(fresh[0].1.peak, 0.5);

        // Age is what makes a reading mean "not playing" rather than "quiet",
        // so a zero-length window has to reject it.
        assert!(levels.fresh_all(Duration::ZERO).is_empty());
    }

    #[test]
    fn recording_again_replaces_the_previous_reading() {
        let levels = SourceLevels::new();
        levels.record("game.exe", 0.25, 0.5);
        levels.record("game.exe", 0.1, 0.9);

        let fresh = levels.fresh_all(Duration::from_secs(60));
        assert_eq!(fresh.len(), 1, "one program, one reading");
        assert_eq!(fresh[0].1.rms, 0.1);
        assert_eq!(fresh[0].1.peak, 0.9);
    }

    #[test]
    fn readings_come_back_sorted_so_the_order_does_not_shift() {
        let levels = SourceLevels::new();
        for name in ["music.exe", "chat.exe", "game.exe"] {
            levels.record(name, 0.2, 0.3);
        }
        let names: Vec<String> = levels
            .fresh_all(Duration::from_secs(60))
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert_eq!(names, vec!["chat.exe", "game.exe", "music.exe"]);
    }

    #[test]
    fn one_program_is_not_a_group() {
        let playing = vec![("solo.exe".to_string(), level(0.5, 0.5))];
        assert!(aligned_gains(&playing).is_empty());
    }

    #[test]
    fn a_group_of_silence_is_left_alone() {
        // Dividing by a zero level is a gain of nothing meaningful, and the NaN
        // it produces would reach the stored percentage as silence.
        let playing = vec![
            ("a.exe".to_string(), level(0.0, 0.0)),
            ("b.exe".to_string(), level(0.0, 0.0)),
        ];
        assert!(aligned_gains(&playing).is_empty());
    }

    #[test]
    fn the_quieter_program_is_brought_up_to_the_loudest() {
        let playing = vec![
            ("loud.exe".to_string(), level(0.5, 0.5)),
            ("quiet.exe".to_string(), level(0.25, 0.25)),
        ];
        let gains = aligned_gains(&playing);
        assert_eq!(gains[0].0, "loud.exe");
        // The target is the loudest level less the headroom margin, so the loud
        // program comes down a little and the quiet one comes up to meet it.
        assert!((gains[0].1 - 0.7).abs() < 1e-6, "gain was {}", gains[0].1);
        assert_eq!(gains[1].0, "quiet.exe");
        assert!((gains[1].1 - 1.4).abs() < 1e-6, "gain was {}", gains[1].1);
    }

    #[test]
    fn a_programs_own_peak_bounds_the_gain_that_would_clip_it() {
        // The quiet program already peaks at full scale, so it cannot be raised
        // at all: the ratio asks for 1.4 and its peak allows 1.0.
        let playing = vec![
            ("loud.exe".to_string(), level(0.5, 0.5)),
            ("crunchy.exe".to_string(), level(0.25, 1.0)),
        ];
        let gains = aligned_gains(&playing);
        assert_eq!(gains[1].1, 1.0);
    }

    #[test]
    fn a_very_quiet_program_stops_at_the_level_ceiling() {
        // 0.35 / 0.01 asks for a gain of 35. The ceiling is how far a program's
        // own level may be raised before its noise floor comes up with it.
        let playing = vec![
            ("loud.exe".to_string(), level(0.5, 0.5)),
            ("whisper.exe".to_string(), level(0.01, 0.01)),
        ];
        let gains = aligned_gains(&playing);
        assert_eq!(gains[1].1, SOURCE_VOLUME_MAX as f32 / 100.0);
    }
}
