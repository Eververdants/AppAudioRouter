//! A mirror's render thread: the device session, and the reports.
//!
//! [`render_main`] is the thread entry — apartment, device, an initialized-but-not
//! started [`RenderSession`] ([`open_render_session`]) — and the two reporting
//! helpers every failure path funnels through: [`mirror_ready`] (one device done
//! initializing, which is what lets the start gate open and the latency readings
//! exist) and [`fail_mirror`] (one device out of service, reported on its own so
//! the rest of the route keeps playing). [`EventGuard`] exists so a failure inside
//! that window cannot leak the kernel handle.
//!
//! The two teardown steps the capture thread calls are here as well:
//! [`hold_after_lost_copies`] (the engine keeps its seat with no copy left to make)
//! and [`join_render_threads`] (a panicked render thread still reports). The loop
//! that plays audio once a session is started is [`super::pump`].

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use log::warn;
use serde_json::json;
use tauri::{AppHandle, Emitter};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Media::Audio::{
    IAudioClient, IAudioRenderClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, WAVEFORMATEX,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
use windows::Win32::System::Threading::CreateEventW;

use crate::audio::AudioError;

use super::mirror::MirrorChannel;
use super::pump::render_run;
use super::shared::{EngineShared, ExitReason};
use super::{CAPTURE_WAIT_MS, STREAM_BUFFER_DURATION};
use crate::audio::process_is_running;

/// Entry point of one mirror's render thread.
pub(super) fn render_main(shared: Arc<EngineShared>, mirror: Arc<MirrorChannel>, app: AppHandle) {
    let com_owned = match crate::audio::init_com() {
        Ok(owned) => owned,
        Err(e) => {
            fail_mirror(&shared, &mirror, &app, e);
            // A failed mirror must not hold the synchronized-start gate open.
            mirror_ready(&shared, &app);
            return;
        }
    };

    match open_render_session(&shared, &mirror) {
        Ok(session) => {
            mirror_ready(&shared, &app);
            render_run(&shared, &mirror, session, &app);
        }
        Err(e) => {
            fail_mirror(&shared, &mirror, &app, e);
            mirror_ready(&shared, &app);
        }
    }

    crate::audio::uninit_com(com_owned);
}

/// Count one mirror as initialized and, when the last one is in, tell the
/// frontend the engine has something to report.
///
/// A mirror asks its endpoint for the endpoint's own stream latency while it
/// initializes, so until this point the reading is not missing by accident, it
/// simply does not exist yet. `apply_route` has answered long before any of this
/// (the render threads are spawned behind an asynchronous device activation), so
/// without this event the frontend would read an empty reading — and keep it,
/// because nothing else asks again until some later, unrelated action.
pub(super) fn mirror_ready(shared: &EngineShared, app: &AppHandle) {
    let previous = shared.ready_count.fetch_add(1, Ordering::Relaxed);
    if previous + 1 != shared.mirrors.len() {
        return;
    }
    let _ = app.emit(
        "duplication-ready",
        json!({
            "pid": shared.pid,
            "generation": shared.generation,
        }),
    );
}

/// Take one mirror out of service and tell the frontend why.
///
/// The engine keeps running for the devices that did open, so nothing else
/// reports this — and a `warn!` in a release build goes to a stderr the window
/// subsystem discards. Without the event a route that lost one of its targets
/// still shows as fully applied, which is indistinguishable from the app being
/// broken: the second device is silent and there is nothing on screen to say so.
pub(super) fn fail_mirror(
    shared: &EngineShared,
    mirror: &MirrorChannel,
    app: &AppHandle,
    error: AudioError,
) {
    mirror.enabled.store(false, Ordering::Relaxed);
    if mirror.feed_tap {
        // A feed's tap failing is not a device of this route going quiet: the
        // route is untouched, and the board must keep its device rows. What it
        // is, is the other programme silently no longer recording anything, so
        // it gets its own report.
        warn!("the feed tap of PID {} failed: {error}", shared.pid);
        let _ = app.emit(
            "feed-tap-failed",
            json!({
                "pid": shared.pid,
                "generation": shared.generation,
                "error": error.to_string(),
            }),
        );
        return;
    }
    warn!("mirror device {} failed: {error}", mirror.device_id);
    let _ = app.emit(
        "duplication-mirror-failed",
        json!({
            "pid": shared.pid,
            "generation": shared.generation,
            "deviceId": mirror.device_id,
            "error": error.to_string(),
        }),
    );
}

/// Wait without the loopback client for as long as every copy is dead.
///
/// An engine whose mirrors have all failed would otherwise keep the loopback
/// tap alive forever — and a plain engine stop is not an option either,
/// because `duplication-stopped` takes the whole route, the still-playing
/// primary included, off the board. So the thread waits, cheap and registered,
/// until the route ends by itself: a user stop, or the program's exit.
///
/// What wakes it: a stop or re-route of this program sets the shutdown flag
/// and calls [`wake_capture`], the same token semantics every other park in
/// this module uses; the `CAPTURE_WAIT_MS` timeout is only the backstop for a
/// wakeup that never arrives, and doubles as the idle engine's liveness check
/// — the same one poll per two seconds a quiet-but-serving engine already
/// pays. Nothing else can wake it, and nothing else should: the mirrors are
/// dead and no packet revives them.
pub(super) fn hold_after_lost_copies(shared: &EngineShared) -> ExitReason {
    *shared
        .capture_worker
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(std::thread::current());
    warn!(
        "duplication for PID {} lost every copy: the route plays on the primary alone",
        shared.pid
    );
    loop {
        if shared.shutdown.load(Ordering::Relaxed) {
            return ExitReason::Stopped;
        }
        if !process_is_running(shared.pid, shared.creation_time) {
            return ExitReason::ProcessExited;
        }
        // The park is armed before the next pass of the checks, so a stop that
        // lands between a check and the park leaves its token here and the
        // park returns at once.
        std::thread::park_timeout(Duration::from_millis(CAPTURE_WAIT_MS as u64));
    }
}

/// Join every mirror's render thread, reporting the ones that died in a panic.
///
/// The join result used to be ignored on the theory that render threads
/// report their own failures through `enabled` — true, until one panics (a
/// frame-arithmetic divide, say) and unwinds past every report: the mirror
/// stays enabled, its ring grows with nobody popping, the board shows a copy
/// playing that has no thread behind it, and nothing is logged. A panicked
/// join now says so, and takes the mirror out of service through the same
/// channel its clean failures use.
pub(super) fn join_render_threads(
    shared: &EngineShared,
    app: &AppHandle,
    render_threads: Vec<(Arc<MirrorChannel>, std::thread::JoinHandle<()>)>,
) {
    for (mirror, handle) in render_threads {
        if let Err(payload) = handle.join() {
            let detail = payload
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "panic without a message".to_string());
            fail_mirror(
                shared,
                &mirror,
                app,
                AudioError::Api(format!("render thread panicked: {detail}")),
            );
        }
    }
}

/// A kernel event handle that closes itself unless somebody takes ownership.
///
/// It exists for the window between `CreateEventW` and the session that is
/// supposed to own the handle: `Initialize`, `SetEventHandle`, `GetService` and
/// `GetBufferSize` all sit in that window and all can fail, and each failure
/// used to leave the handle open for the life of the app — one per mirror, per
/// retry, on a tray-resident process whose devices come and go. On the success
/// path `std::mem::forget` disarms it, and `RenderSession`'s own `Drop` closes
/// the handle exactly once, as it always has.
struct EventGuard(HANDLE);

impl Drop for EventGuard {
    fn drop(&mut self) {
        // SAFETY: this guard is the only owner, and the handle it holds came
        // from CreateEventW. A session that took the handle forgot this guard,
        // so no path closes the same handle twice.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

/// A fully initialized render client, not yet started.
pub(super) struct RenderSession {
    pub(super) client: IAudioClient,
    pub(super) render: IAudioRenderClient,
    pub(super) event: HANDLE,
    pub(super) buffer_frames: usize,
}

impl Drop for RenderSession {
    fn drop(&mut self) {
        // SAFETY: balances CreateEventW in open_render_session.
        unsafe {
            let _ = CloseHandle(self.event);
        }
    }
}

/// Open and initialize one mirror's render client, without starting it.
fn open_render_session(
    shared: &EngineShared,
    mirror: &MirrorChannel,
) -> Result<RenderSession, AudioError> {
    let com_err =
        |what: &str, e: windows::core::Error| AudioError::Api(format!("{what} failed: {e}"));
    let device_id = mirror.device_id.clone();
    let enumerator: IMMDeviceEnumerator = unsafe {
        // SAFETY: MMDeviceEnumerator is the registered coclass.
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .map_err(|e| com_err("CoCreateInstance", e))?
    };
    let wide: Vec<u16> = device_id.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: wide is NUL-terminated and outlives the call.
    let device = unsafe {
        enumerator
            .GetDevice(PCWSTR(wide.as_ptr()))
            .map_err(|e| com_err("GetDevice", e))?
    };
    // SAFETY: activating IAudioClient on an active render device.
    let client: IAudioClient = unsafe {
        device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| com_err("Activate(IAudioClient)", e))?
    };
    let event = unsafe {
        // SAFETY: unnamed auto-reset event; owned by RenderSession.
        CreateEventW(None, false, false, None).map_err(|e| com_err("CreateEventW", e))?
    };
    let guard = EventGuard(event);
    // SAFETY: format is a complete WAVEFORMATEX(EXTENSIBLE) copied from the
    // default device's mix format; auto-convert adapts it to this device.
    let format = unsafe { &*(shared.format.as_ptr() as *const WAVEFORMATEX) };
    // SAFETY: shared-mode event-driven render; periodicity must be 0.
    // AUTOCONVERTPCM lets the shared capture format stand in for this device's
    // own engine mix; an endpoint that rejects the conversion path still works
    // without it, so fall back exactly as the capture side does — a mirror that
    // fails to initialize is a device the user hears nothing from.
    unsafe {
        client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                    | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                    | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                STREAM_BUFFER_DURATION,
                0,
                format,
                None,
            )
            .or_else(|_| {
                client.Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                    STREAM_BUFFER_DURATION,
                    0,
                    format,
                    None,
                )
            })
            .map_err(|e| com_err("Initialize(render)", e))?;
        client
            .SetEventHandle(event)
            .map_err(|e| com_err("SetEventHandle(render)", e))?;
    }
    let render: IAudioRenderClient = unsafe {
        client
            .GetService()
            .map_err(|e| com_err("GetService(IAudioRenderClient)", e))?
    };
    // SAFETY: GetBufferSize on an initialized client; frames are in units of
    // the requested (capture) format, matching the ring buffers.
    let buffer_frames = unsafe {
        client
            .GetBufferSize()
            .map_err(|e| com_err("GetBufferSize", e))?
    } as usize;
    // SAFETY: GetStreamLatency on an initialized client; it reports in 100 ns
    // units how far ahead of the hardware this client's frames are queued, i.e.
    // the endpoint's own contribution to the total.
    match unsafe { client.GetStreamLatency() } {
        // Not clamped upwards: a value this large would mean the endpoint is
        // already broken, and reporting it beats reporting a plausible lie.
        Ok(hns) => mirror.stream_latency_ms.store(
            (hns / 10_000).clamp(0, u32::MAX as i64) as u32,
            Ordering::Relaxed,
        ),
        Err(e) => warn!("GetStreamLatency failed for {}: {e}", mirror.device_id),
    }
    // The session takes the handle with it; disarming the guard here is what
    // keeps the close to exactly once.
    std::mem::forget(guard);
    Ok(RenderSession {
        client,
        render,
        event,
        buffer_frames,
    })
}
