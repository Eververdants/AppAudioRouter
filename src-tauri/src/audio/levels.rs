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

use log::info;

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
///
/// Ages are measured with `Instant` (the query performance counter), never the
/// system time: a clock correction, or the machine coming back from sleep, must
/// not make a stale reading look fresh or a fresh one look stale. Sleep is the
/// case that *should* age everything out, and it does — the engines publish on
/// arrival of a packet, so after a long sleep every entry in here is old.
pub const LEVEL_MAX_AGE: Duration = Duration::from_millis(1_000);

/// How long an entry may stay in the table before it is dropped outright.
///
/// Past [`LEVEL_MAX_AGE`] a reading is already not returned; it is only kept
/// because the engine that took it may be alive and about to publish again — a
/// program that paused is the same program. Once it is this old, nothing is
/// refreshing it: a parked engine wakes on the first packet and publishes with
/// it, and an engine that is over calls [`SourceLevels::forget`] on the way out.
/// `forget` is the prompt path; this is the net under it, for the exits that
/// never reached it, so the table cannot grow with the session.
pub const LEVEL_TRIM_AGE: Duration = Duration::from_secs(60);

/// How old a reading is against a clock the caller supplies.
///
/// `Instant::elapsed` is what production uses; taking `now` separately is what
/// lets the age rule — the whole contract of this table — be tested without
/// waiting on a clock, and it keeps a clock that somehow reads backwards from
/// ageing an entry out.
fn age_of(at: Instant, now: Instant) -> Duration {
    now.checked_duration_since(at).unwrap_or_default()
}

/// Drop readings past `age`, returning how many went.
fn trim_older_than(
    levels: &mut HashMap<(String, u32), SourceLevel>,
    now: Instant,
    age: Duration,
) -> usize {
    let before = levels.len();
    levels.retain(|_, level| age_of(level.at, now) < age);
    before - levels.len()
}

/// Level measurements for every program an engine is duplicating.
///
/// Written by each engine's capture thread and read by the commands and by the
/// level alignment. Interior mutability, like the config files, because it is
/// reached through shared state.
///
/// Keyed by **program and PID together**, even though a level belongs to the
/// program. One program can hold several engines at once — several windows of a
/// browser, each routed by hand — and each of them measures a *different* piece
/// of audio, so a table keyed by the program alone would keep whichever engine
/// folded last and hand an alignment a number that describes neither. The
/// readings are folded up to the program on the way out instead (see
/// `fresh_all`).
#[derive(Default)]
pub struct SourceLevels {
    levels: Mutex<HashMap<(String, u32), SourceLevel>>,
}

impl SourceLevels {
    /// An empty table.
    pub fn new() -> Self {
        Self::default()
    }

    /// Record the current estimate for one engine's program, replacing whatever
    /// that engine published last.
    ///
    /// Every write also trims the table, because this is the only call made
    /// regularly enough for the sweep to be worth paying for — and an entry
    /// nobody trimmed would sit here for the rest of the session.
    pub fn record(&self, exe_name: &str, pid: u32, rms: f32, peak: f32) {
        let now = Instant::now();
        let mut levels = self.levels.lock().unwrap_or_else(|e| e.into_inner());
        levels.insert(
            (exe_name.to_string(), pid),
            SourceLevel { rms, peak, at: now },
        );
        let dropped = trim_older_than(&mut levels, now, LEVEL_TRIM_AGE);
        if dropped > 0 {
            info!("dropped {dropped} level reading(s) no engine refreshed");
        }
    }

    /// Drop one engine's reading.
    ///
    /// Called when the engine that published under `(exe_name, pid)` is over:
    /// nothing will refresh the number again, so the entry would sit in the
    /// table for the life of the process. The pause-and-resume case the stale
    /// filter below protects does not apply — there is no engine left to
    /// resume.
    pub fn forget(&self, exe_name: &str, pid: u32) {
        self.levels
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&(exe_name.to_string(), pid));
    }

    /// Every program still being measured, as `(exe_name, level)` pairs sorted
    /// by name so the order a caller sees does not shift under it.
    ///
    /// A program with several engines reporting collapses to its **loudest**
    /// one, for both numbers. The level is the program's, so the loudest window
    /// is what the program is doing; and taking the highest peak is the
    /// conservative half of that choice, since the peak is what bounds a gain.
    ///
    /// Readings that have gone stale are dropped here rather than removed on the
    /// way in: a program that pauses and resumes is the same program, and
    /// forgetting its number would throw away the estimate that is about to be
    /// refreshed anyway.
    pub fn fresh_all(&self, max_age: Duration) -> Vec<(String, SourceLevel)> {
        let now = Instant::now();
        let levels = self.levels.lock().unwrap_or_else(|e| e.into_inner());
        let mut folded: HashMap<&str, SourceLevel> = HashMap::new();
        for ((exe_name, _), level) in levels.iter() {
            if age_of(level.at, now) >= max_age {
                continue;
            }
            folded
                .entry(exe_name.as_str())
                .and_modify(|kept| {
                    kept.rms = kept.rms.max(level.rms);
                    kept.peak = kept.peak.max(level.peak);
                    kept.at = kept.at.max(level.at);
                })
                .or_insert(*level);
        }
        let mut fresh: Vec<(String, SourceLevel)> = folded
            .into_iter()
            .map(|(name, level)| (name.to_string(), level))
            .collect();
        fresh.sort_by(|a, b| a.0.cmp(&b.0));
        fresh
    }
}

/// Below this the measured level counts as silence rather than as a quiet
/// program, about −60 dBFS.
///
/// A program that measured as silence has no ratio to take: the target over its
/// level is unbounded, so it would be clamped to the ceiling and stored there —
/// a 400 % gain waiting for the first sound the program makes.
const SILENT_LEVEL: f32 = 1e-3;

/// How far below the group's loudest measured level the whole aligned group
/// lands — the loudest included, so everything plays at one shared level.
///
/// Several programs aligned to the same level add up at the device, and that sum
/// belongs to the Windows mixer where this side cannot see it. So this is a
/// courtesy margin rather than a guarantee: with many programs playing at once,
/// the device volume is still the control that has to move.
pub const ALIGN_HEADROOM: f32 = 0.7;

/// How many programs in `playing` measured above silence.
///
/// The count a human ear would give — a program making sound is playing,
/// whether or not there were enough of them to align against each other.
/// `aligned_gains` answers what can be aligned; this answers what was
/// actually sounding, which is what an empty result has to be explained with.
pub fn audible_count(playing: &[(String, SourceLevel)]) -> usize {
    playing
        .iter()
        .filter(|(_, level)| level.rms > SILENT_LEVEL)
        .count()
}

/// What each program in a group needs to be as loud as the others, as
/// `(exe_name, gain)`, where a gain of 1.0 leaves that program's audio alone.
///
/// Empty when there is nothing to align: fewer than two programs are audible,
/// which covers both "only one is playing" (one program cannot be aligned
/// against itself) and "none of them measured above silence" (there is no ratio
/// to take, and the one a silent program would produce means nothing). Each
/// program is judged on its own reading, so one quiet program among playing ones
/// is left out of the group rather than emptying it.
///
/// Each gain is bounded twice — once by the ceiling a program's own level may
/// reach, and once by that program's measured peak. The second bound is what
/// makes amplification safe: a gain of `1 / peak` puts a program's loudest
/// sample at full scale and can put nothing past it.
pub fn aligned_gains(playing: &[(String, SourceLevel)]) -> Vec<(String, f32)> {
    // A program that measured as silence is not part of the group: it has no
    // level to align to, and boosting it is precisely what the ceiling would do.
    let audible: Vec<&(String, SourceLevel)> = playing
        .iter()
        .filter(|(_, level)| level.rms > SILENT_LEVEL)
        .collect();
    if audible.len() < 2 {
        return Vec::new();
    }
    let loudest = audible
        .iter()
        .map(|(_, level)| level.rms)
        .fold(0.0f32, f32::max);
    let target = loudest * ALIGN_HEADROOM;
    let ceiling = SOURCE_VOLUME_MAX as f32 / 100.0;
    audible
        .into_iter()
        .map(|(exe_name, level)| {
            // The peak bound keeps the gain under what this program was heard to
            // reach, so the material it was measured on cannot be pushed past
            // full scale. It says nothing about material that comes later and is
            // louder — the gain is stored and reused — which is why the docs
            // promise "cannot clip what was measured" rather than "cannot clip".
            let peak_bound = 1.0 / level.peak.max(f32::MIN_POSITIVE);
            let bound = ceiling.min(peak_bound);
            let gain = (target / level.rms).clamp(0.0, bound);
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

    /// The trim is a net under `forget`, so it has to be able to say which
    /// entries nothing is refreshing any more — and keep the ones a paused
    /// program is about to refresh.
    #[test]
    fn readings_nobody_refreshes_are_dropped_from_the_table() {
        let now = Instant::now();
        let mut table = HashMap::new();
        table.insert(
            ("old.exe".to_string(), 11),
            SourceLevel {
                rms: 0.2,
                peak: 0.3,
                at: now,
            },
        );
        table.insert(
            ("older.exe".to_string(), 22),
            SourceLevel {
                rms: 0.2,
                peak: 0.3,
                at: now,
            },
        );

        // An hour on: both are past the horizon, and a table never trimmed would
        // carry them for the rest of the session.
        let later = now + Duration::from_secs(3_600);
        assert_eq!(trim_older_than(&mut table, later, LEVEL_TRIM_AGE), 2);
        assert!(table.is_empty());

        // Inside the horizon they stay, however stale the *answer* already is:
        // the engine that took the reading may be parked rather than gone.
        table.insert(
            ("paused.exe".to_string(), 33),
            SourceLevel {
                rms: 0.3,
                peak: 0.4,
                at: now,
            },
        );
        assert_eq!(
            trim_older_than(&mut table, now + LEVEL_MAX_AGE * 4, LEVEL_TRIM_AGE),
            0
        );
        assert_eq!(table.len(), 1);
    }

    /// A clock that reads backwards (it cannot with `Instant`, but the age rule
    /// is the whole contract of this table) must not age an entry out at zero.
    #[test]
    fn a_reading_never_measures_as_negative_age() {
        let now = Instant::now();
        assert_eq!(age_of(now, now), Duration::ZERO);
        assert_eq!(age_of(now + Duration::from_secs(5), now), Duration::ZERO);
    }

    #[test]
    fn a_reading_is_fresh_until_it_ages_out() {
        let levels = SourceLevels::new();
        levels.record("game.exe", 42, 0.25, 0.5);

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
        levels.record("game.exe", 42, 0.25, 0.5);
        levels.record("game.exe", 42, 0.1, 0.9);

        let fresh = levels.fresh_all(Duration::from_secs(60));
        assert_eq!(fresh.len(), 1, "one program, one reading");
        assert_eq!(fresh[0].1.rms, 0.1);
        assert_eq!(fresh[0].1.peak, 0.9);
    }

    #[test]
    fn one_programs_engines_fold_to_its_loudest() {
        // Two windows of one browser, each routed by hand and each measuring a
        // different piece of audio. The level belongs to the program, so the
        // table has to report what the program is doing — and keeping the
        // highest peak is the conservative half of that, because the peak is
        // what bounds a gain.
        let levels = SourceLevels::new();
        levels.record("browser.exe", 100, 0.4, 0.5);
        levels.record("browser.exe", 200, 0.05, 0.06);

        let fresh = levels.fresh_all(Duration::from_secs(60));
        assert_eq!(fresh.len(), 1, "one program, however many engines");
        assert_eq!(fresh[0].1.rms, 0.4);
        assert_eq!(fresh[0].1.peak, 0.5);
    }

    #[test]
    fn readings_come_back_sorted_so_the_order_does_not_shift() {
        let levels = SourceLevels::new();
        for name in ["music.exe", "chat.exe", "game.exe"] {
            levels.record(name, 42, 0.2, 0.3);
        }
        let names: Vec<String> = levels
            .fresh_all(Duration::from_secs(60))
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        assert_eq!(names, vec!["chat.exe", "game.exe", "music.exe"]);
    }

    #[test]
    fn the_audible_count_is_what_an_ear_would_give() {
        // One audible program: nothing to align, but something was playing —
        // and the report has to say that rather than "nothing was".
        let playing = vec![
            ("loud.exe".to_string(), level(0.5, 0.5)),
            ("muted.exe".to_string(), level(0.0, 0.0)),
        ];
        assert_eq!(audible_count(&playing), 1);
        assert!(aligned_gains(&playing).is_empty());
    }

    #[test]
    fn one_program_is_not_a_group() {
        let playing = vec![("solo.exe".to_string(), level(0.5, 0.5))];
        assert!(aligned_gains(&playing).is_empty());
    }

    #[test]
    fn a_program_that_measured_as_silence_is_not_part_of_the_group() {
        // Its ratio is unbounded, so it would land on the ceiling and be stored
        // there: a 400 % gain waiting for the first sound the program makes.
        let playing = vec![
            ("loud.exe".to_string(), level(0.5, 0.5)),
            ("muted.exe".to_string(), level(0.0, 0.0)),
        ];
        // One audible program cannot be aligned against itself.
        assert!(aligned_gains(&playing).is_empty());

        // And with two audible programs it is left out rather than aligned.
        let mut with_two = playing.clone();
        with_two.push(("quiet.exe".to_string(), level(0.25, 0.25)));
        let gains = aligned_gains(&with_two);
        assert_eq!(gains.len(), 2, "the muted program is not in the group");
        assert!(gains.iter().all(|(name, _)| name != "muted.exe"));
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
