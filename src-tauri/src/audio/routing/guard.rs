//! Who may not be routed, and who an entry on the books still speaks for.
//!
//! `routing_refusal` is the guard every endpoint write passes through — it is
//! called by [`super::endpoints::set_process_default_endpoint_flow`], the one
//! door both data flows share, and by nothing else: an unreadable process name
//! refuses as firmly as a name on the list, because the protected processes are
//! exactly the ones this app cannot open. `entry_process_is_ours` is the other
//! question asked of a pid: whether a still-live process under that pid really
//! is the program a book entry was written for, which is what keeps a recycled
//! pid from speaking for someone else's route or feed.

/// Whether `pid` still names the process this book entry was written for.
///
/// With a captured witness this is the exact question: `process_is_running`
/// compares the creation time, so a pid the kernel has since handed to another
/// program answers `no`.
///
/// Without one it is not. `creation_time` of 0 means the process could not be
/// opened when the entry was written — most often because it had already exited
/// a moment after the write that got it routed — and `process_is_running` then
/// judges only the exit code: *any* live process holding that pid would be read
/// as ours, which is exactly the recycling this witness exists to prevent. Left
/// as the answer, a stranger would speak for the entry: its executable hidden
/// from the settings reset, its feeds suspended for good, its stale bookkeeping
/// dropped before the assignment is handed back.
///
/// So the entry falls back to the next best witness, the executable name. The
/// assignment the entry describes is stored per executable anyway, so a process
/// of the same program still holds it and a process of another one does not; an
/// entry that cannot even say whose it is has no witness at all and answers
/// `no`, because the paths that ask all have a conservative reading of `no`.
pub(super) fn entry_process_is_ours(pid: u32, creation_time: u64, exe_name: &str) -> bool {
    if creation_time != 0 {
        return crate::audio::process_is_running(pid, creation_time);
    }
    if !crate::audio::process_is_running(pid, 0) {
        return false;
    }
    if exe_name.is_empty() {
        return false;
    }
    process_name_for_guard(pid).is_some_and(|name| name.eq_ignore_ascii_case(exe_name))
}

// ---------------------------------------------------------------------------
// Safety rails
// ---------------------------------------------------------------------------

/// Executables whose audio belongs to Windows itself.
///
/// Moving one of these is refused rather than half-applied: the audio service
/// is a system-critical process, and a wrong endpoint on it is the kind of
/// mistake that leaves a machine without sound.
const PROTECTED_EXES: [&str; 9] = [
    "system",
    "registry",
    "smss.exe",
    "csrss.exe",
    "wininit.exe",
    "services.exe",
    "lsass.exe",
    "winlogon.exe",
    "audiodg.exe",
];

/// Why routing this PID must be refused, in the words the log and the frontend
/// will see; `None` means it may be routed.
///
/// PID 0 (the system-sounds session) and PID 4 (`System`) are protected by
/// identity, everything else by executable name.
///
/// A name that cannot be read at all is refused too, and that is the part worth
/// reading twice. The processes this list exists for are the ones an ordinary
/// user cannot open — `csrss.exe`, `lsass.exe`, `audiodg.exe` are protected
/// against exactly that — so an unreadable name is where they hide, and
/// guessing "not on the list" re-points every session a program holds, which is
/// the one mistake here that would take the whole machine's audio with it. The
/// price is that a program running more elevated than this app cannot be routed;
/// the message says which of the two happened instead of accusing it.
pub fn routing_refusal(pid: u32) -> Option<&'static str> {
    if pid == 0 || pid == 4 {
        return Some("a system-critical process");
    }
    match process_name_for_guard(pid) {
        Some(name) => PROTECTED_EXES
            .iter()
            .any(|protected| name.eq_ignore_ascii_case(protected))
            .then_some("a system-critical process"),
        None => Some("a process this app cannot identify"),
    }
}

/// The executable name the guard compares against `PROTECTED_EXES`.
///
/// `QueryFullProcessImageNameW` first: it needs less of a right than the
/// image-name API and hands back a real path. The `A` form is the fallback, not
/// the other way round — its fixed 260-byte buffer reports nothing for a longer
/// path, and "nothing" was the answer that let a protected process through.
pub(super) fn process_name_for_guard(pid: u32) -> Option<String> {
    crate::audio::process_meta::process_image(pid)
        .map(|(_, name)| name)
        .or_else(|| crate::audio::sessions::get_process_exe_name(pid))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_processes_are_protected() {
        assert_eq!(routing_refusal(0), Some("a system-critical process"));
        assert_eq!(routing_refusal(4), Some("a system-critical process"));
    }

    /// The guard reads a name it can and refuses only what is on the list — a
    /// readable process that is not one of them stays routable.
    #[test]
    fn an_ordinary_process_is_not_protected() {
        assert_eq!(routing_refusal(std::process::id()), None);
    }
}
