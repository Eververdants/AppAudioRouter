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

#[cfg(test)]
mod tests {
    use super::*;

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
}
