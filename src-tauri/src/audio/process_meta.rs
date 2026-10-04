//! Process metadata beyond audio: the executable's image path, a display name
//! to show instead of the bare file name, and — for the icon command — the
//! executable's icon.
//!
//! None of this talks to Core Audio. It runs on the same blocking workers the
//! enumeration commands use (one pass per refresh, event-driven, never a poll)
//! and never on the notification thread, whose COM pointers must not leave it
//! (see `notifications.rs`).

use std::collections::{HashMap, HashSet};

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM};

/// The full image path (drive-letter form) and file name of a process.
///
/// `QueryFullProcessImageNameW` rather than the image-name API the routing
/// side uses: that one reports a device path (`\Device\HarddiskVolume…`),
/// which neither the shell icon API below nor the version-resource reader can
/// open. The file name is the same either way.
pub(crate) fn process_image(pid: u32) -> Option<(String, String)> {
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    // SAFETY: OpenProcess with QUERY_LIMITED_INFORMATION is safe.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()? };

    let result = (|| -> Option<(String, String)> {
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        // SAFETY: buf/len are a valid output pair, and `handle` is alive.
        unsafe {
            QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                PWSTR(buf.as_mut_ptr()),
                &mut len,
            )
            .ok()?;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        let name = path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string();
        Some((path, name))
    })();

    // SAFETY: CloseHandle balances OpenProcess.
    unsafe {
        let _ = CloseHandle(handle);
    }
    result
}

/// The best window title of every process in `pids`, collected in one pass.
///
/// `EnumWindows` walks top-level windows in Z order, topmost first, so the
/// first visible window that has a title, owns nothing and is not a tool
/// window is the window the user would call "the app's window". Anything
/// behind it counts only when no such window exists, and a process with only
/// untitled windows — most background helpers — gets no entry at all, which
/// the caller reads as "fall back to the file description".
pub(crate) fn window_titles(pids: &[u32]) -> HashMap<u32, String> {
    use windows::Win32::UI::WindowsAndMessaging::EnumWindows;

    let mut collector = TitleCollector {
        wanted: pids.iter().copied().collect(),
        best: HashMap::new(),
    };
    // SAFETY: `collect_title` reads state only through the pointer handed to
    // it in `lparam`, which outlives the call on this same thread.
    let enumerated = unsafe {
        EnumWindows(
            Some(collect_title),
            LPARAM(&mut collector as *mut TitleCollector as isize),
        )
    };
    if let Err(e) = enumerated {
        log::warn!("window title walk failed: {e}");
    }
    collector
        .best
        .into_iter()
        .map(|(pid, (_, title))| (pid, title))
        .collect()
}

/// What the `EnumWindows` walk accumulates: the best title so far per process,
/// plus the processes that could still improve their rank.
struct TitleCollector {
    wanted: HashSet<u32>,
    /// pid -> (rank, title); a lower rank wins.
    best: HashMap<u32, (u8, String)>,
}

/// Ranks for a window with a non-empty title; lower is better.
const RANK_MAIN: u8 = 0;
const RANK_VISIBLE: u8 = 1;
const RANK_ANY: u8 = 2;

// SAFETY: `lparam` is the `TitleCollector` pointer passed to `EnumWindows`,
// and USER32 invokes this on the calling thread, so the access is exclusive.
unsafe extern "system" fn collect_title(hwnd: HWND, lparam: LPARAM) -> BOOL {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindow, GetWindowLongPtrW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
        GWL_EXSTYLE, GW_OWNER, WS_EX_TOOLWINDOW,
    };

    let collector = &mut *(lparam.0 as *mut TitleCollector);
    if collector.wanted.is_empty() {
        // Every process already has its best possible window; the rest of the
        // walk could not improve anything.
        return BOOL(0);
    }

    let mut pid = 0u32;
    // SAFETY: pid is a valid out parameter.
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if !collector.wanted.contains(&pid) {
        return BOOL(1);
    }

    let mut buf = [0u16; 256];
    // SAFETY: buf is a valid buffer. For another process's window this reads
    // the cached caption rather than sending a message, so it cannot hang.
    let len = unsafe { GetWindowTextW(hwnd, &mut buf) };
    if len == 0 {
        return BOOL(1);
    }
    let title = String::from_utf16_lossy(&buf[..len as usize]);

    let visible = unsafe { IsWindowVisible(hwnd) }.as_bool();
    let tool_window =
        unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } & WS_EX_TOOLWINDOW.0 as isize != 0;
    // GetWindow reports "no owner" as a NULL handle, which windows-rs turns
    // into an Err; either way this window counts as unowned.
    let unowned = match unsafe { GetWindow(hwnd, GW_OWNER) } {
        Ok(owner) => owner.is_invalid(),
        Err(_) => true,
    };

    let rank = if visible && unowned && !tool_window {
        RANK_MAIN
    } else if visible {
        RANK_VISIBLE
    } else {
        RANK_ANY
    };

    if collector
        .best
        .get(&pid)
        .is_none_or(|&(best_rank, _)| rank < best_rank)
    {
        if rank == RANK_MAIN {
            collector.wanted.remove(&pid);
        }
        collector.best.insert(pid, (rank, title));
    }
    BOOL(1)
}

/// The `FileDescription` string of an executable's version resource — the name
/// Task Manager shows — or `None` when the file carries none.
///
/// The fallback for processes without a usable window: a background player or
/// a game's sound helper still deserves a name a person can read.
pub(crate) fn file_description(path: &str) -> Option<String> {
    use windows::Win32::Storage::FileSystem::{
        GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
    };

    let path_w = wide(path);
    // SAFETY: path_w is a NUL-terminated wide string, read-only here.
    let size = unsafe { GetFileVersionInfoSizeW(PCWSTR(path_w.as_ptr()), None) };
    if size == 0 {
        return None;
    }
    let mut data = vec![0u8; size as usize];
    // SAFETY: data is `size` bytes, as the size call just reported.
    unsafe {
        GetFileVersionInfoW(PCWSTR(path_w.as_ptr()), 0, size, data.as_mut_ptr().cast()).ok()?;
    }

    // The strings live under a language/codepage pair; read the table instead
    // of guessing one, then try each pair until one carries a description.
    let mut table: *mut core::ffi::c_void = core::ptr::null_mut();
    let mut table_len = 0u32;
    let found = unsafe {
        VerQueryValueW(
            data.as_ptr().cast(),
            PCWSTR(wide(r"\VarFileInfo\Translation").as_ptr()),
            &mut table,
            &mut table_len,
        )
    };
    if !found.as_bool() || table.is_null() || table_len < 4 {
        return None;
    }
    // SAFETY: the table is an array of (language, codepage) u16 pairs inside
    // `data`, which outlives every read below.
    let pairs = unsafe { std::slice::from_raw_parts(table as *const u16, table_len as usize / 2) };

    for pair in pairs.as_chunks::<2>().0 {
        let (lang, codepage) = (pair[0], pair[1]);
        let sub =
            wide(format!(r"\StringFileInfo\{lang:04x}{codepage:04x}\FileDescription").as_str());
        let mut value: *mut core::ffi::c_void = core::ptr::null_mut();
        let mut value_len = 0u32;
        let found = unsafe {
            VerQueryValueW(
                data.as_ptr().cast(),
                PCWSTR(sub.as_ptr()),
                &mut value,
                &mut value_len,
            )
        };
        if !found.as_bool() || value.is_null() || value_len < 2 {
            continue;
        }
        // SAFETY: a NUL-terminated UTF-16 string inside `data`.
        let text =
            unsafe { std::slice::from_raw_parts(value as *const u16, value_len as usize / 2) };
        let text = String::from_utf16_lossy(text);
        let text = text.trim_end_matches('\0').trim();
        if !text.is_empty() {
            return Some(text.to_string());
        }
    }
    None
}

/// A NUL-terminated UTF-16 copy of `s`, for the `PCWSTR` parameters above.
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}
