//! Launch-at-startup, written straight into `HKCU\Software\Microsoft\Windows\
//! CurrentVersion\Run`.
//!
//! The official `tauri-plugin-autostart` performs the same registry write. Adding
//! it would cost a Rust crate, an npm package, a capability entry, and the
//! crate/npm version lockstep the Tauri CLI enforces — so this keeps the
//! dependency count at zero, which is the constraint this project lives by.
//!
//! The registered command line carries [`HIDDEN_ARG`] so a logon launch stays in
//! the tray instead of dropping a window in front of a half-awake user.

use std::ffi::c_void;

use log::warn;
use windows::core::w;
use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, WIN32_ERROR};
use windows::Win32::System::Registry::{
    RegCloseKey, RegDeleteKeyValueW, RegOpenKeyExW, RegQueryValueExW, RegSetKeyValueW, HKEY,
    HKEY_CURRENT_USER, KEY_READ, REG_SZ,
};

const SUBKEY: windows::core::PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
/// Registry value name. Stable: renaming it strands existing users' autostart.
const VALUE_NAME: windows::core::PCWSTR = w!("AppAudioRouter");
/// Argument that makes a launched instance skip showing its window.
pub const HIDDEN_ARG: &str = "--hidden";

/// The command line this install would register.
fn our_command() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe failed: {e}"))?;
    Ok(format!("\"{}\" {HIDDEN_ARG}", exe.display()))
}

/// Read the `Run` value for this app, if it exists.
fn stored_command() -> Result<Option<String>, String> {
    let mut key = HKEY(std::ptr::null_mut());
    // SAFETY: HKCU is always open, the subkey buffer is a valid wide literal,
    // and `key` is closed on every path below.
    let status = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, SUBKEY, 0, KEY_READ, &mut key) };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    win32_result(status, "RegOpenKeyExW")?;

    let result = (|| -> Result<Option<String>, String> {
        // First pass asks for the size, second one fills a buffer of it.
        let mut size: u32 = 0;
        let mut kind = REG_SZ;
        // SAFETY: null data with a non-null size is the documented query.
        let status = unsafe {
            RegQueryValueExW(
                key,
                VALUE_NAME,
                None,
                Some(&mut kind),
                None,
                Some(&mut size),
            )
        };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        win32_result(status, "RegQueryValueExW")?;

        let mut buf = vec![0u8; size as usize];
        let mut read = size;
        // SAFETY: `buf` is `size` bytes and `read` is updated by the call.
        let status = unsafe {
            RegQueryValueExW(
                key,
                VALUE_NAME,
                None,
                Some(&mut kind),
                Some(buf.as_mut_ptr()),
                Some(&mut read),
            )
        };
        win32_result(status, "RegQueryValueExW")?;

        // as_chunks yields (chunks, remainder); REG_SZ data is always even-length.
        let units: Vec<u16> = buf[..read as usize]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect();
        Ok(Some(
            String::from_utf16_lossy(&units)
                .trim_end_matches('\0')
                .to_string(),
        ))
    })();

    // SAFETY: balances RegOpenKeyExW.
    unsafe {
        let _ = RegCloseKey(key);
    }
    result
}

/// Turn a `WIN32_ERROR` into a `Result`, naming the call that produced it.
fn win32_result(status: WIN32_ERROR, call: &str) -> Result<(), String> {
    if status == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(format!("{call} failed: 0x{:08X}", status.0))
    }
}

/// Whether this app is registered to start at logon.
pub fn is_enabled() -> Result<bool, String> {
    Ok(stored_command()?.is_some())
}

/// What reading the startup entry back after a write said about that write.
#[derive(Debug, PartialEq, Eq)]
enum ReadBack {
    /// The entry now holds exactly what the write intended.
    Matches,
    /// The entry holds something else: a group policy, or another program.
    Different(String),
    /// The entry is not there, though the write meant to put it there.
    Absent,
    /// The entry could not be read, so the write is confirmed neither way.
    Unreadable(String),
}

/// Compare a re-read of the entry with what the write was meant to leave behind.
///
/// `wanted` is the command line for a registration, `None` for a removal. Kept
/// apart from the registry calls so the verdict can be tested without touching
/// anyone's real startup entries.
fn judge_read_back(wanted: Option<&str>, seen: Result<Option<String>, String>) -> ReadBack {
    match seen {
        Ok(Some(found)) => match wanted {
            Some(command) if found == command => ReadBack::Matches,
            // Something else owns that name now; saying "registered" about it
            // would be a lie either way, so the text is handed back.
            _ => ReadBack::Different(found),
        },
        Ok(None) => {
            if wanted.is_none() {
                ReadBack::Matches
            } else {
                ReadBack::Absent
            }
        }
        Err(e) => ReadBack::Unreadable(e),
    }
}

/// Turn the verdict into the answer `set_enabled` gives the settings switch.
///
/// An unreadable result is the one case that is not a failure: the registry call
/// itself reported success, and a second call that cannot confirm it must not
/// make the switch snap back and blame the user for a write that landed. It does
/// get said out loud, because from here on the entry is unverified.
fn confirm_write(wanted: Option<&str>, seen: Result<Option<String>, String>) -> Result<(), String> {
    match judge_read_back(wanted, seen) {
        ReadBack::Matches => Ok(()),
        // Only a registration can reach this arm: an absent entry after a
        // removal is the requested end state, and is judged `Matches`.
        ReadBack::Absent => Err("the startup entry was gone again after being written".to_string()),
        ReadBack::Different(found) => Err(match wanted {
            Some(command) => {
                format!("the startup entry says {found} after being written as {command}")
            }
            None => format!("the startup entry is still registered after removal: {found}"),
        }),
        ReadBack::Unreadable(e) => {
            warn!("could not confirm the startup entry after writing it: {e}");
            Ok(())
        }
    }
}

/// Register or unregister this app as a logon startup.
///
/// The answer is what the registry holds afterwards, not what the write call
/// reported: this value is the whole truth about the settings switch, and a
/// success that did not land would leave the switch pointing at a startup that
/// never happens.
pub fn set_enabled(enabled: bool) -> Result<(), String> {
    if !enabled {
        // SAFETY: the key/value are static wide literals; deleting a value that
        // is not there is exactly the requested end state.
        let status = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, SUBKEY, VALUE_NAME) };
        if status != ERROR_FILE_NOT_FOUND {
            win32_result(status, "RegDeleteKeyValueW")?;
        }
        return confirm_write(None, stored_command());
    }

    let command = our_command()?;
    let wide: Vec<u16> = command.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: `wide` outlives the call and its length is passed in bytes;
    // RegSetKeyValueW creates the subkey when missing. Only this app's own
    // value name under HKCU\...\Run is ever written — never HKLM, never a
    // sibling value, and the key itself is never deleted.
    let status = unsafe {
        RegSetKeyValueW(
            HKEY_CURRENT_USER,
            SUBKEY,
            VALUE_NAME,
            REG_SZ.0,
            Some(wide.as_ptr() as *const c_void),
            (wide.len() * std::mem::size_of::<u16>()) as u32,
        )
    };
    win32_result(status, "RegSetKeyValueW")?;
    confirm_write(Some(&command), stored_command())
}

/// Re-point the startup value at this executable when it no longer matches.
///
/// A moved or reinstalled app leaves the old path behind, and Windows then fails
/// the logon launch silently. Rewriting is cheap and only happens on a mismatch.
pub fn repair_if_drifted() {
    let registered = match stored_command() {
        Ok(registered) => registered,
        Err(e) => {
            warn!("could not read the startup entry: {e}");
            return;
        }
    };
    let Some(registered) = registered else {
        // Autostart is off; there is nothing to keep in step.
        return;
    };
    let ours = match our_command() {
        Ok(ours) => ours,
        Err(e) => {
            warn!("could not read the own executable path: {e}");
            return;
        }
    };
    if registered != ours {
        if let Err(e) = set_enabled(true) {
            warn!("could not refresh the startup entry: {e}");
        }
    }
}

/// Whether an argument list carries the silent-launch flag.
///
/// Split out from [`is_silent_launch`] so the rule can be tested against a
/// command line of choice instead of against this process's own.
fn has_hidden_flag<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().any(|arg| arg.as_ref() == HIDDEN_ARG)
}

/// True when Windows launched this instance at logon rather than the user.
///
/// The first argument is the executable itself, so it is skipped: a path that
/// ends in `--hidden` is a folder name, not a flag.
pub fn is_silent_launch() -> bool {
    has_hidden_flag(std::env::args().skip(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The startup entry the registry must hold for a logon launch to happen.
    #[test]
    fn the_registered_command_line_quotes_the_executable_and_adds_the_flag() {
        let ours = our_command().expect("this test process has an executable path");
        assert!(
            ours.starts_with('"'),
            "a path with spaces would be split by the Run key: {ours}"
        );
        assert!(
            ours.ends_with(HIDDEN_ARG),
            "a logon launch that shows its window is not a background one: {ours}"
        );
    }

    #[test]
    fn the_hidden_flag_is_read_from_the_arguments_after_the_program() {
        assert!(has_hidden_flag(["--hidden"]));
        assert!(has_hidden_flag(["some", "--hidden", "other"]));
        assert!(!has_hidden_flag(["--Hidden"]));
        assert!(!has_hidden_flag(Vec::<String>::new()));
        // The program itself is never an argument, so a directory called
        // `--hidden` cannot make a normal launch go silent.
        assert!(!has_hidden_flag(["C:\\--hidden\\App.exe"]));
    }

    /// The switch describes the registry, so a write is only done once the
    /// registry says so.
    #[test]
    fn a_written_entry_is_confirmed_by_reading_it_back() {
        let ours = "\"C:\\Program Files\\App.exe\" --hidden";
        assert_eq!(
            confirm_write(Some(ours), Ok(Some(ours.to_string()))),
            Ok(()),
            "the entry says what it was written to say"
        );
        assert_eq!(
            confirm_write(None, Ok(None)),
            Ok(()),
            "a removal is confirmed by an absent entry"
        );
    }

    #[test]
    fn an_entry_that_did_not_take_the_write_is_reported_as_a_failure() {
        let ours = "\"C:\\App.exe\" --hidden";
        let stale = "\"C:\\Old\\App.exe\" --hidden";
        let err = confirm_write(Some(ours), Ok(Some(stale.to_string())))
            .expect_err("a stale entry is not our registration");
        assert!(err.contains(stale) && err.contains(ours), "{err}");

        let err = confirm_write(Some(ours), Ok(None)).expect_err("nothing was written");
        assert!(err.contains("gone again"), "{err}");

        // And a removal that left the value standing is not "unregistered".
        let err = confirm_write(None, Ok(Some(stale.to_string())))
            .expect_err("the entry outlived its own removal");
        assert!(err.contains("still registered"), "{err}");
    }

    /// A failed *confirmation* is not a failed write: the switch would snap back
    /// and blame the user for something the registry may well have accepted.
    #[test]
    fn an_unreadable_entry_is_a_warning_rather_than_a_refused_write() {
        assert_eq!(
            confirm_write(Some("\"C:\\App.exe\" --hidden"), Err("denied".to_string())),
            Ok(()),
            "the write itself reported success"
        );
    }
}
