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

        let units: Vec<u16> = buf[..read as usize]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
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

/// Register or unregister this app as a logon startup.
pub fn set_enabled(enabled: bool) -> Result<(), String> {
    if !enabled {
        // SAFETY: the key/value are static wide literals; deleting a value that
        // is not there is exactly the requested end state.
        let status = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, SUBKEY, VALUE_NAME) };
        return if status == ERROR_FILE_NOT_FOUND {
            Ok(())
        } else {
            win32_result(status, "RegDeleteKeyValueW")
        };
    }

    let command = our_command()?;
    let wide: Vec<u16> = command.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: `wide` outlives the call and its length is passed in bytes;
    // RegSetKeyValueW creates the subkey when missing.
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
    win32_result(status, "RegSetKeyValueW")
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

/// True when Windows launched this instance at logon rather than the user.
pub fn is_silent_launch() -> bool {
    std::env::args().skip(1).any(|arg| arg == HIDDEN_ARG)
}
