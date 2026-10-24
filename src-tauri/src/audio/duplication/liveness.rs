//! Whether the engine's process is still the process it started for.
//!
//! The loopback event only fires while the target plays audio, so a silent engine
//! would never notice its program leaving. The two idle polls in
//! [`super::capture`] and [`super::render`] answer that with
//! [`process_alive`]: the exit code says gone, and a creation time recorded at
//! [`super::start`] says *recycled* — a stranger wearing the same pid.
//!
//! A creation time that could not be read is deliberately not treated as zero:
//! `recorded_time == 0` means "no witness", and only the exit code is judged.

use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE, STILL_ACTIVE};
use windows::Win32::System::Threading::{
    GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// Creation time as a FILETIME (u64) read from an already-open process handle,
/// or None if the query failed. The caller owns the handle and has already
/// established that the process has not exited.
fn creation_time_of(handle: HANDLE) -> Option<u64> {
    let mut creation = FILETIME::default();
    let mut _exit = FILETIME::default();
    let mut _kernel = FILETIME::default();
    let mut _user = FILETIME::default();
    // SAFETY: valid handle and out params.
    let read =
        unsafe { GetProcessTimes(handle, &mut creation, &mut _exit, &mut _kernel, &mut _user) }
            .is_ok();
    if !read {
        return None;
    }
    Some(((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64)
}

/// Process creation time as a FILETIME (u64), or None if unavailable.
pub(super) fn process_creation_time(pid: u32) -> Option<u64> {
    // SAFETY: OpenProcess with QUERY_LIMITED_INFORMATION; the handle is closed
    // on both exits below, so a failed query does not leak it.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()? };
    let creation = creation_time_of(handle);
    // SAFETY: balances OpenProcess.
    unsafe {
        let _ = CloseHandle(handle);
    }
    creation
}

/// Returns true while `pid` still refers to the same process that was alive at
/// `recorded_time`. Detects PID reuse by comparing creation times.
pub(super) fn process_alive(pid: u32, recorded_time: u64) -> bool {
    // SAFETY: OpenProcess with QUERY_LIMITED_INFORMATION; handle closed below.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) };
    match handle {
        Ok(h) => {
            // A terminated-but-still-referenced process opens fine with the
            // query right, so the exit has to be read from the exit code:
            // `WaitForSingleObject` would need `SYNCHRONIZE` on top of
            // `PROCESS_QUERY_LIMITED_INFORMATION`, and the wait it refuses
            // (`WAIT_FAILED`) is indistinguishable from "still running" — which
            // is how an engine outlived its program whenever a launcher, a
            // parent shell or a service kept the last handle open.
            let mut exit_code = 0u32;
            // SAFETY: h is a valid handle, exit_code is a live out parameter.
            let exited = unsafe { GetExitCodeProcess(h, &mut exit_code) }.is_ok()
                && exit_code != STILL_ACTIVE.0 as u32;
            let alive = if exited {
                false
            } else if recorded_time == 0 {
                // No recorded creation time means there is nothing to compare
                // against: reading 0 as a timestamp would call a live process a
                // recycled one on the first idle poll and tear the engine down.
                true
            } else {
                // A different creation time means the PID was recycled. This is
                // read from the handle already open rather than a second
                // OpenProcess: it is the same process object, and this runs on
                // an idle engine's poll, where the extra handle pair would be
                // paid for nothing.
                creation_time_of(h).is_none_or(|current| current == recorded_time)
            };
            // SAFETY: balances OpenProcess.
            unsafe {
                let _ = CloseHandle(h);
            }
            alive
        }
        // The process was openable when the route was applied, so an
        // OpenProcess failure now means it is gone.
        Err(_) => false,
    }
}
