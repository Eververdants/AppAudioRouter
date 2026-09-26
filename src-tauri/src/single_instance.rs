//! Ensures a single app instance, hand-rolled from two kernel objects.
//!
//! A named mutex in the `Local\` (per-logon-session) namespace answers "is the
//! app already running": the first instance creates it, everyone else sees
//! `ERROR_ALREADY_EXISTS`. A named auto-reset event lets a second launch ask
//! the first to bring its window up, which is what a user re-opening the app
//! almost certainly means — "I clicked and nothing happened" is not an answer
//! a tray-only app gets away with.
//!
//! Hand-rolled rather than `tauri-plugin-single-instance` for the same reason
//! as `autostart`: the plugin would add a version-locked npm/Cargo pair for
//! what two kernel objects do in one small file.

use std::os::windows::io::OwnedHandle;

use tauri::{AppHandle, Manager};
use windows::core::{PCWSTR, w};
use windows::Win32::Foundation::{ERROR_ALREADY_EXISTS, GetLastError, HANDLE, WAIT_OBJECT_0};
use windows::Win32::System::Threading::{
    CreateEventW, CreateMutexW, INFINITE, SetEvent, WaitForSingleObject,
};

/// Per-session mutex naming this app. `Local\` leaves other logon sessions
/// (RDP) free to run their own instance — the audio engine is per-session
/// anyway, so those instances never fight over anything.
const MUTEX_NAME: PCWSTR = w!("Local\\AppAudioRouter.SingleInstance");

/// Auto-reset event a second launch signals to reveal the first one's window.
const EVENT_NAME: PCWSTR = w!("Local\\AppAudioRouter.ShowWindow");

/// Holds the instance mutex for the process lifetime (managed app state).
pub struct SingleInstanceGuard {
    /// `None` only when the mutex could not be created and the app chose to
    /// keep running unguarded rather than refuse to start at all.
    #[allow(dead_code)]
    mutex: Option<OwnedHandle>,
}

/// Makes this process the single instance, or reports that one already exists.
///
/// `Some` — even on internal failures, which degrade to a warned-about
/// unguarded run — means the caller continues. `None` means another instance
/// holds the name and has been asked to show its window; the caller should
/// exit immediately, before touching configs or audio sessions.
pub fn acquire(app: AppHandle) -> Option<SingleInstanceGuard> {
    // The event comes before the mutex on purpose: CreateEventW opens the
    // existing object by name, so a second launch that races the first still
    // signals the very object the first instance waits on.
    let event = match open_show_event() {
        Ok(event) => Some(event),
        Err(e) => {
            log::warn!("could not open the single-instance event: {e}");
            None
        }
    };

    // SAFETY: no security attributes, not initially owned, and the name is a
    // static wide literal.
    let mutex = match unsafe { CreateMutexW(None, false, MUTEX_NAME) } {
        Ok(handle) => handle,
        Err(e) => {
            log::warn!("could not create the single-instance mutex: {e}; running unguarded");
            return Some(SingleInstanceGuard { mutex: None });
        }
    };

    // A success carrying ERROR_ALREADY_EXISTS means the name was taken and this
    // handle is a duplicate of the winner's mutex, not a new object. GetLastError
    // stays untouched on the crate's Ok path, so checking it here is reliable.
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        // Balance the duplicate; the winner's mutex is the one that lives.
        drop(unsafe { OwnedHandle::from_raw_handle(mutex.0) });
        if let Some(event) = &event {
            // SAFETY: `event` is a valid handle; signaling it is infallible for
            // the caller — a missed reveal costs nothing but a hidden window.
            let _ = unsafe { SetEvent(HANDLE(event.as_raw_handle())) };
        }
        return None;
    }

    if let Some(event) = event {
        spawn_reveal_watcher(event, app);
    }
    Some(SingleInstanceGuard {
        mutex: Some(unsafe { OwnedHandle::from_raw_handle(mutex.0) }),
    })
}

/// Opens (or, before the first instance made it, creates) the show-window
/// event. Either way every instance ends up with the same named object.
fn open_show_event() -> Result<OwnedHandle, windows::core::Error> {
    // SAFETY: no security attributes, auto-reset, initially clear, and the name
    // is a static wide literal.
    let handle = unsafe { CreateEventW(None, false, false, EVENT_NAME) }?;
    // SAFETY: `handle` was just returned by CreateEventW and is owned exactly
    // once from here on.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle.0) })
}

/// Waits forever for second launches, revealing this instance's window each time.
fn spawn_reveal_watcher(event: OwnedHandle, app: AppHandle) {
    // A plain thread is fine here: when `main` returns the process exits and
    // the wait dies with it, so the thread cannot outlive the app no matter
    // what it holds.
    let spawned = std::thread::Builder::new()
        .name("single-instance-reveal".into())
        .spawn(move || loop {
            // SAFETY: `event` is owned by this thread and valid for every wait.
            let waited = unsafe { WaitForSingleObject(HANDLE(event.as_raw_handle()), INFINITE) };
            if waited != WAIT_OBJECT_0 {
                return; // the event handle is gone; there is nothing left to wait on
            }
            log::info!("second launch detected; showing the window");
            let Some(window) = app.get_webview_window("main") else {
                return; // the window is gone, so there is nothing to reveal
            };
            crate::tray::reveal(&window);
        });
    if let Err(e) = spawned {
        log::warn!("could not start the single-instance watcher: {e}");
    }
}
