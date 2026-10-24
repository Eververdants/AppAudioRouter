//! The executable name — the key every program-side record of this app is stored
//! under.
//!
//! Routes, levels, feeds, endpoint pins and icons are all keyed by exe; a display
//! name never enters a key. So reading a pid's name and refusing a blank one belong
//! together: the first is what the write path records for the assignment it just
//! made, the second is the guard on the same value arriving as an argument. Both
//! are here rather than in the command that needs them because three paths share
//! the guard, and a blank key costs the same in all of them.

use log::warn;

use crate::audio;

/// The executable name of `pid`, or an empty string when it cannot be read.
///
/// The name is bookkeeping for the assignments the audio service persists per
/// executable, so failing to read it must not fail the route. It must not pass
/// unnoticed either: a blank name is what later leaves a sweep unable to say
/// which program an assignment belongs to, and looks like the assignment
/// belongs to no program at all.
pub(super) fn exe_name_of(pid: u32) -> String {
    match audio::sessions::get_process_exe_name(pid) {
        Some(name) => name,
        None => {
            warn!("PID {pid} has no readable executable name; its assignment is recorded unnamed");
            String::new()
        }
    }
}

/// Refuse a command that names no program.
///
/// Every program-side key this app persists is an executable name, and a blank
/// one is a record no session can ever match: it would sit on the settings page
/// as a remembered rule nobody owns, be read by no engine, and — for a feed —
/// stand behind an endpoint pin no removal can find again. The write path already
/// refuses a process whose name it cannot read; this stops the same nonsense
/// arriving as an argument instead of being inferred from one.
pub(super) fn require_exe_name(what: &str, exe_name: &str) -> Result<(), String> {
    if exe_name.trim().is_empty() {
        return Err(format!("{what} needs the program it applies to"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A command that names no program cannot be carried out: every program-side
    /// key is the executable name, so a blank one is a rule nothing can read back
    /// or forget later.
    #[test]
    fn a_command_that_names_no_program_is_refused() {
        assert!(require_exe_name("a route", "game.exe").is_ok());
        assert!(require_exe_name("a route", "").is_err());
        assert!(
            require_exe_name("a route", "   ").is_err(),
            "a name of nothing but spaces is a blank key beside every session"
        );
    }
}
