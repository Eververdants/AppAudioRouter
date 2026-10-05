//! Process metadata beyond audio: the executable's image path, a display name
//! to show instead of the bare file name, and — for the icon command — the
//! executable's icon.
//!
//! None of this talks to Core Audio. It runs on the same blocking workers the
//! enumeration commands use (one pass per refresh, event-driven, never a poll)
//! and never on the notification thread, whose COM pointers must not leave it
//! (see `notifications.rs`).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM};
use windows::Win32::Graphics::Gdi::{HBITMAP, HDC};
use windows::Win32::UI::WindowsAndMessaging::ICONINFO;

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
/// window is the window the user would call "the app's window". A visible
/// window behind it counts only when no such window exists, and a process
/// with no *visible* titled window — one whose UI lives in another process,
/// or that sits in the tray — gets no entry at all, which the caller reads as
/// "fall back to the file description".
///
/// Invisible windows never qualify, and that is the point: their captions are
/// somebody's plumbing. Steam's main process owns a hidden window captioned
/// literally 无标题 while the visible "Steam" window belongs to
/// steamwebhelper.exe — a fallback that accepts hidden windows displays that
/// junk, where the file description would have said "Steam".
pub(crate) fn window_titles(pids: &[u32]) -> HashMap<u32, String> {
    use windows::Win32::UI::WindowsAndMessaging::EnumWindows;

    let mut collector = TitleCollector {
        wanted: pids.iter().copied().collect(),
        best: HashMap::new(),
        stopped_early: false,
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
        if !collector.stopped_early {
            log::warn!("window title walk failed: {e}");
        }
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
    /// Set when the collector itself ended the walk — every wanted process
    /// already holds its best possible window, and the rest of the Z order
    /// could not improve anything. `EnumWindows` reports that early stop as a
    /// failure like any other, and it must not be logged as one.
    stopped_early: bool,
}

/// Ranks for a window with a non-empty title; lower is better. Only visible
/// windows rank at all.
const RANK_MAIN: u8 = 0;
const RANK_VISIBLE: u8 = 1;

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
        // walk could not improve anything. Marked as the collector's own early
        // stop, so the caller does not read it as a failure.
        collector.stopped_early = true;
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
    if !visible {
        // An invisible window's caption is plumbing, not a name: Steam's main
        // process carries a hidden window titled 无标题, IME helpers say
        // "Default IME". A window the user cannot see is never what "the
        // app's window" means, so it is skipped entirely — the file
        // description is the honest fallback for a tray-resident program.
        return BOOL(1);
    }
    let tool_window =
        unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } & WS_EX_TOOLWINDOW.0 as isize != 0;
    // GetWindow reports "no owner" as a NULL handle, which windows-rs turns
    // into an Err; either way this window counts as unowned.
    let unowned = match unsafe { GetWindow(hwnd, GW_OWNER) } {
        Ok(owner) => owner.is_invalid(),
        Err(_) => true,
    };

    let rank = if unowned && !tool_window {
        RANK_MAIN
    } else {
        RANK_VISIBLE
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
        // VerQueryValueW's length word is **characters including the null**
        // for a string value — it is bytes only for the Translation table
        // above. Reading the string as bytes halved it, which is how
        // "Microsoft Edge" (14 chars, 15 with the null) reached the screen as
        // "Microso".
        //
        // SAFETY: a NUL-terminated UTF-16 string inside `data`.
        let text = unsafe { std::slice::from_raw_parts(value as *const u16, value_len as usize) };
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

/// One executable's icon as raw pixels.
#[derive(Debug, Clone, Serialize)]
pub struct IconImage {
    pub width: u32,
    pub height: u32,
    /// Base64 of the RGBA rows, top-down, four bytes per pixel. Base64 rather
    /// than raw bytes so the payload rides through JSON as one string instead
    /// of thousands of numbers; the frontend decodes it into an `ImageData`.
    pub rgba: String,
}

/// The icon of whatever executable `pid` is running, decoded and cached.
///
/// The cache is keyed by image path and holds **hits only**: the shell's
/// extraction is worth remembering when it succeeded, but a miss is retried
/// the next time somebody asks. The failures a miss covers — a process mid-
/// death, a file mid-update, a shell call that lost a race — are exactly the
/// ones a later ask should be able to get past, and caching them once turned
/// a transient loss into a whole run without an icon. Failed asks are cheap
/// and the ask cadence is event-driven, so there is nothing to rate-limit
/// here. The cache lives for this run only; nothing persists to disk.
pub fn icon_for_process(pid: u32) -> Option<IconImage> {
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<IconImage>>>> = OnceLock::new();

    let (path, name) = process_image(pid)?;
    let key = path.to_ascii_lowercase();
    if let Some(cached) = CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&key)
    {
        return Some(cached.as_ref().clone());
    }

    let icon = extract_icon(&path);
    log::debug!(
        "icon for {name}: {}",
        match &icon {
            Some(icon) => format!("{}x{}", icon.width, icon.height),
            None => "none (will retry on the next ask)".to_string(),
        }
    );
    let icon = Arc::new(icon?);
    CACHE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(key, Arc::clone(&icon));
    Some(icon.as_ref().clone())
}

/// Ask the shell for the file's large icon and decode it into RGBA.
fn extract_icon(path: &str) -> Option<IconImage> {
    use windows::Win32::Graphics::Gdi::DeleteObject;
    use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

    let path_w = wide(path);
    let mut info = SHFILEINFOW::default();
    // SAFETY: path_w is a NUL-terminated wide string and info is the output
    // record the size argument describes. The file-attributes argument only
    // matters with SHGFI_USEFILEATTRIBUTES, which is not set here.
    let ok = unsafe {
        SHGetFileInfoW(
            PCWSTR(path_w.as_ptr()),
            FILE_ATTRIBUTE_NORMAL,
            Some(&mut info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        )
    };
    if ok == 0 {
        return None;
    }

    let mut icon = ICONINFO::default();
    // SAFETY: icon is a valid output record for this HICON.
    let decoded = unsafe { GetIconInfo(info.hIcon, &mut icon) }
        .ok()
        .and_then(|()| decode_icon(&icon));
    // SAFETY: GetIconInfo handed us the two bitmaps and SHGetFileInfoW the
    // icon; each is balanced with its own destructor.
    unsafe {
        let _ = DeleteObject(icon.hbmMask);
        if !icon.hbmColor.is_invalid() {
            let _ = DeleteObject(icon.hbmColor);
        }
        let _ = DestroyIcon(info.hIcon);
    }
    decoded
}

/// Decode an `ICONINFO`'s bitmaps into RGBA rows, top-down.
///
/// A colour icon brings its own 32-bit bitmap; the alpha channel is used when
/// the icon has one, and the AND mask stands in when it does not — that is the
/// classic (pre-XP) icon format, and without the fallback it would read as a
/// solid rectangle. A monochrome icon has no colour bitmap at all: its mask
/// bitmap's top half is the image (1 = white), the bottom half the
/// transparency.
fn decode_icon(icon: &ICONINFO) -> Option<IconImage> {
    use windows::Win32::Graphics::Gdi::{GetDC, GetObjectW, ReleaseDC, BITMAP};

    let have_color = !icon.hbmColor.is_invalid();
    let mut bmp = BITMAP::default();
    // SAFETY: bmp is a valid out parameter sized for this handle.
    let filled = unsafe {
        GetObjectW(
            if have_color {
                icon.hbmColor
            } else {
                icon.hbmMask
            },
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bmp as *mut BITMAP as *mut core::ffi::c_void),
        )
    };
    if filled == 0 || bmp.bmWidth <= 0 || bmp.bmHeight <= 0 {
        return None;
    }
    let width = bmp.bmWidth as usize;
    let height = if have_color {
        bmp.bmHeight as usize
    } else {
        // The mask bitmap of a monochrome icon holds XOR half and AND half.
        bmp.bmHeight as usize / 2
    };
    if width == 0 || height == 0 {
        return None;
    }

    // SAFETY: a screen DC is only the context GetDIBits needs; the bitmaps are
    // not selected into it, and every call below reads handles it was given.
    let hdc = unsafe { GetDC(None) };
    if hdc.is_invalid() {
        return None;
    }
    let decoded = if have_color {
        decode_color_icon(hdc, icon, width, height)
    } else {
        decode_monochrome_icon(hdc, icon, width, height)
    };
    // SAFETY: balances GetDC.
    unsafe {
        let _ = ReleaseDC(None, hdc);
    }
    decoded
}

/// The colour half: 32-bit BGRA rows, with the AND mask filling in the alpha
/// when the icon predates per-pixel alpha.
fn decode_color_icon(hdc: HDC, icon: &ICONINFO, width: usize, height: usize) -> Option<IconImage> {
    let bgra = dib_bits(hdc, icon.hbmColor, width, height, 32)?;
    let mask = dib_bits(hdc, icon.hbmMask, width, height, 1)?;
    let has_alpha = bgra.iter().skip(3).step_by(4).any(|&a| a != 0);
    let row_bytes = width.div_ceil(32) * 4;
    let mask_bit =
        |x: usize, y: usize| -> bool { mask[y * row_bytes + x / 8] >> (7 - (x % 8)) & 1 == 1 };

    let mut rgba = vec![0u8; width * height * 4];
    for (pixel, out) in rgba.as_chunks_mut::<4>().0.iter_mut().enumerate() {
        out[0] = bgra[pixel * 4 + 2];
        out[1] = bgra[pixel * 4 + 1];
        out[2] = bgra[pixel * 4];
        // AND mask bit 1 means "transparent"; with a real alpha channel the
        // mask says nothing and is ignored.
        out[3] = if has_alpha {
            bgra[pixel * 4 + 3]
        } else if mask_bit(pixel % width, pixel / width) {
            0
        } else {
            255
        };
    }
    Some(IconImage {
        width: width as u32,
        height: height as u32,
        rgba: base64(&rgba),
    })
}

/// The monochrome half: the mask bitmap's top half is the XOR image (1 =
/// white), the bottom half the AND mask (1 = transparent).
fn decode_monochrome_icon(
    hdc: HDC,
    icon: &ICONINFO,
    width: usize,
    height: usize,
) -> Option<IconImage> {
    let bits = dib_bits(hdc, icon.hbmMask, width, height * 2, 1)?;
    let row_bytes = width.div_ceil(32) * 4;
    let bit =
        |x: usize, y: usize| -> bool { bits[y * row_bytes + x / 8] >> (7 - (x % 8)) & 1 == 1 };

    let mut rgba = vec![0u8; width * height * 4];
    for (pixel, out) in rgba.as_chunks_mut::<4>().0.iter_mut().enumerate() {
        let level = if bit(pixel % width, pixel / width) {
            255u8
        } else {
            0
        };
        out[0] = level;
        out[1] = level;
        out[2] = level;
        out[3] = if bit(pixel % width, pixel / width + height) {
            0
        } else {
            255
        };
    }
    Some(IconImage {
        width: width as u32,
        height: height as u32,
        rgba: base64(&rgba),
    })
}

/// Read an HBITMAP into top-down rows: four bytes per pixel at 32 bpp (BGRA),
/// packed bits at 1 bpp, rows padded to 32-bit boundaries.
fn dib_bits(hdc: HDC, bitmap: HBITMAP, width: usize, height: usize, bpp: u16) -> Option<Vec<u8>> {
    use windows::Win32::Graphics::Gdi::{
        GetDIBits, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };

    let row_bytes = match bpp {
        32 => width * 4,
        1 => width.div_ceil(32) * 4,
        _ => return None,
    };
    // GetDIBits fills the colour table of this record as well as the buffer.
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            // Negative height reads the rows top-down, which is the order the
            // frontend's `ImageData` expects.
            biHeight: -(height as i32),
            biPlanes: 1,
            biBitCount: bpp,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut buf = vec![0u8; row_bytes * height];
    // SAFETY: buf is exactly the buffer this header describes, and the bitmap
    // is not selected into hdc.
    let rows = unsafe {
        GetDIBits(
            hdc,
            bitmap,
            0,
            height as u32,
            Some(buf.as_mut_ptr().cast()),
            &mut info,
            DIB_RGB_COLORS,
        )
    };
    if rows == 0 {
        return None;
    }
    Some(buf)
}

/// Standard base64, local because a whole dependency for one encode is not
/// worth it and the payload should be text, not four thousand JSON numbers.
fn base64(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    let full = data.len() / 3 * 3;
    for chunk in data[..full].as_chunks::<3>().0 {
        let n = ((chunk[0] as u32) << 16) | ((chunk[1] as u32) << 8) | chunk[2] as u32;
        for shift in [18, 12, 6, 0] {
            out.push(ALPHABET[((n >> shift) & 63) as usize] as char);
        }
    }
    let rest = &data[full..];
    if let Some(&first) = rest.first() {
        // Assemble the final 24-bit group first and emit from it: emitting a
        // code before the byte it covers has been folded in is exactly the bug
        // the test vectors are here to catch.
        let mut n = (first as u32) << 16;
        let padded = rest.len() == 1;
        if let Some(&second) = rest.get(1) {
            n |= (second as u32) << 8;
        }
        out.push(ALPHABET[(n >> 18 & 63) as usize] as char);
        out.push(ALPHABET[(n >> 12 & 63) as usize] as char);
        if padded {
            out.push_str("==");
        } else {
            out.push(ALPHABET[(n >> 6 & 63) as usize] as char);
            out.push('=');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{base64, file_description};

    #[test]
    fn base64_matches_the_standard_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn file_description_reads_the_whole_string() {
        // The brand in msedge.exe's version resource is not localized, and
        // Edge ships at this path both here and on CI. "Microsoft Edge" is 14
        // characters (15 with the null), so the bytes-as-length bug cut it to
        // exactly "Microso" — this pins the whole string.
        let path = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe";
        if !std::path::Path::new(path).exists() {
            return; // an install without Edge cannot pin this
        }
        assert_eq!(file_description(path).as_deref(), Some("Microsoft Edge"));
    }
}
