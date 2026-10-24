//! The engine's capture thread: activate the loopback tap and feed the rings.
//!
//! One thread owns the loopback `IAudioClient` for the life of the engine, from
//! [`capture_main`] to the `duplication-stopped` event it emits last. It activates
//! the client ([`super::activation::activate_process_loopback`]), initializes it in
//! shared event-driven loopback mode, spawns one render thread per mirror
//! ([`super::render::render_main`]), and then pumps every captured packet into
//! every ring — measuring the program's level, stamping the source as audible and
//! waking the mirrors, in that order, so a mirror woken by a packet never reads the
//! source as quiet.
//!
//! [`open_gate_when_ready`] is the synchronized start: it opens only once every
//! device is initialized and each ring holds one base pipeline, and opening it is
//! also what wakes the mirrors out of the gate wait.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;

use log::{info, warn};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_TIMEOUT};
use windows::Win32::Media::Audio::{
    IAudioCaptureClient, IAudioClient, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, WAVEFORMATEX,
};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

use crate::audio::AudioError;

use super::activation::activate_process_loopback;
use super::manager::UnregisterOutcome;
use super::metering::{measure_into, LevelTracker};
use super::mirror::MirrorChannel;
use super::render::{
    fail_mirror, hold_after_lost_copies, join_render_threads, mirror_ready, render_main,
};
use super::shared::{note_audio, EngineShared, ExitReason};
use super::DuplicationManager;
use super::{CAPTURE_WAIT_MS, PRE_ROLL_TIMEOUT, STREAM_BUFFER_DURATION};
use crate::audio::process_is_running;

/// Entry point of an engine's capture thread.
pub(super) fn capture_main(shared: Arc<EngineShared>, app: AppHandle) {
    let reason = run_capture(&shared, &app);
    // `capture_session` sets this itself before it joins; this covers the paths
    // that failed before any render thread existed, so no exit route can leave
    // the flag unset.
    shared.shutdown.store(true, Ordering::Relaxed);
    match &reason {
        ExitReason::Stopped => info!(
            "duplication for PID {} stopped ({} mirrors)",
            shared.pid,
            shared.mirrors.len()
        ),
        ExitReason::ProcessExited => {
            info!("duplication for PID {} ended: process exited", shared.pid)
        }
        ExitReason::Error(e) => warn!("duplication for PID {} failed: {e}", shared.pid),
        // Unreachable: `capture_session` converts it into the reason the hold
        // ended before returning. Kept so the match says which one it is.
        ExitReason::AllMirrorsLost => {}
    }
    let mirror_wakes: u64 = shared
        .mirrors
        .iter()
        .map(|m| m.wakeups.load(Ordering::Relaxed))
        .sum();
    info!(
        "engine for PID {} ran {:?}: {} capture waits, {} mirror waits",
        shared.pid,
        shared.started.elapsed(),
        shared.capture_wakeups.load(Ordering::Relaxed),
        mirror_wakes
    );
    let outcome = app
        .state::<DuplicationManager>()
        .unregister(shared.pid, shared.generation);
    // An engine that died on its own error leaves the program playing at the
    // session volume this route claimed — give it back, unless the process
    // (and with it the session) is gone. A clean `Stopped` exit was already
    // restored synchronously by `stop`, and restoring again here could clobber
    // a successor engine's freshly claimed volume.
    if matches!(outcome, UnregisterOutcome::Current) && matches!(reason, ExitReason::Error(_)) {
        shared.restore_session_volume();
    }
    // The level table holds one entry per engine, and this engine will publish
    // no more — `run_capture` has returned — so a `Current` or `Empty` exit
    // leaves its entry orphaned for the life of the process unless it goes
    // now. A `Replaced` exit is the successor's seat: the successor publishes
    // under the same key.
    if !matches!(outcome, UnregisterOutcome::Replaced) {
        shared.levels.forget(&shared.exe_name, shared.pid);
    }
    let _ = app.emit(
        "duplication-stopped",
        json!({
            "pid": shared.pid,
            "generation": shared.generation,
            "reason": reason.event_name(),
            "error": reason.error_message(),
        }),
    );
}

/// Activate the capture client and pump captured frames into the mirror rings.
fn run_capture(shared: &Arc<EngineShared>, app: &AppHandle) -> ExitReason {
    let com_owned = match crate::audio::init_com() {
        Ok(owned) => owned,
        Err(e) => return ExitReason::Error(e),
    };
    let result = capture_loop(shared, app);
    crate::audio::uninit_com(com_owned);
    result
}

fn capture_loop(shared: &Arc<EngineShared>, app: &AppHandle) -> ExitReason {
    match capture_stream(shared, app) {
        Ok(reason) => reason,
        Err(e) => ExitReason::Error(e),
    }
}

fn capture_stream(shared: &Arc<EngineShared>, app: &AppHandle) -> Result<ExitReason, AudioError> {
    let com_err =
        |what: &str, e: windows::core::Error| AudioError::Api(format!("{what} failed: {e}"));
    let client = activate_process_loopback(shared.pid)?;
    if shared.shutdown.load(Ordering::Relaxed) {
        return Ok(ExitReason::Stopped);
    }

    let event = unsafe {
        // SAFETY: no security attributes, unnamed auto-reset event; closed below
        // once the client that was driven by it is gone.
        CreateEventW(None, false, false, None).map_err(|e| com_err("CreateEventW", e))?
    };
    // The client is moved in so that every path — including the ones that fail
    // before the stream ever started — releases it before this closes the event
    // handle it was given.
    let result = capture_session(shared, client, event, app);
    // SAFETY: balances CreateEventW above; no client references the handle now.
    unsafe {
        let _ = CloseHandle(event);
    }
    result
}

/// Initialize the capture client, run one render thread per mirror, and pump
/// frames between them until the engine is over.
fn capture_session(
    shared: &Arc<EngineShared>,
    client: IAudioClient,
    event: HANDLE,
    app: &AppHandle,
) -> Result<ExitReason, AudioError> {
    let com_err =
        |what: &str, e: windows::core::Error| AudioError::Api(format!("{what} failed: {e}"));
    // SAFETY: format is a complete WAVEFORMATEX(EXTENSIBLE) copied from the
    // default device's mix format.
    let format = unsafe { &*(shared.format.as_ptr() as *const WAVEFORMATEX) };
    // SAFETY: shared-mode event-driven process loopback; periodicity must be 0
    // in shared mode. AUTOCONVERTPCM lets the requested format differ from the
    // engine mix; if loopback capture rejects the conversion path, retry with
    // the plain mix format.
    unsafe {
        client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK
                    | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
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
                    AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                    STREAM_BUFFER_DURATION,
                    0,
                    format,
                    None,
                )
            })
            .map_err(|e| com_err("Initialize(capture)", e))?;
    }
    // SAFETY: valid handle; the client is event-driven so the handle must stay
    // valid for the lifetime of the stream. Must come after Initialize.
    if let Err(e) = unsafe { client.SetEventHandle(event) } {
        return Err(com_err("SetEventHandle", e));
    }
    // SAFETY: GetService on a fully initialized capture client.
    let capture: IAudioCaptureClient = unsafe {
        client
            .GetService()
            .map_err(|e| com_err("GetService(IAudioCaptureClient)", e))?
    };
    // SAFETY: Start on a fully initialized capture client.
    if let Err(e) = unsafe { client.Start() } {
        return Err(com_err("Start(capture)", e));
    }

    // Each handle paired with its mirror: a thread that dies in a panic
    // reports through the mirror's own failure channel, not into the void.
    let mut render_threads: Vec<(Arc<MirrorChannel>, std::thread::JoinHandle<()>)> =
        Vec::with_capacity(shared.mirrors.len());
    for mirror in &shared.mirrors {
        let thread_shared = shared.clone();
        let thread_app = app.clone();
        let thread_mirror = mirror.clone();
        let spawned = std::thread::Builder::new()
            .name(format!("aar-render-{}", shared.pid))
            .spawn(move || render_main(thread_shared, thread_mirror, thread_app));
        match spawned {
            Ok(handle) => render_threads.push((mirror.clone(), handle)),
            Err(e) => {
                // The OS refused the thread. Spawning with `thread::spawn`
                // would panic here, and the unwind would tear this capture
                // thread down past every teardown step that follows the
                // capture loop: the engine would stay registered, its mirrors
                // keep their devices open and no stopped event would fire.
                // Take the mirror out of service the way a render thread that
                // lost its device would be, and count it ready, or the start
                // gate waits out its backstop on a report that never comes.
                fail_mirror(
                    shared,
                    mirror,
                    app,
                    AudioError::Api(format!("spawn render thread failed: {e}")),
                );
                mirror_ready(shared, app);
            }
        }
    }

    let mut gate = StartGate {
        opened_at: Instant::now(),
        opened: false,
    };
    let mut reason = capture_packets(shared, &capture, event, &mut gate);
    if matches!(reason, ExitReason::AllMirrorsLost) {
        // The last copy is out of service: nothing on the device side of this
        // engine can make a sound any more, and a started event-driven capture
        // client keeps the endpoint signalling a thread with no consumer.
        // Release the tap for good, then hold the engine registered — stopping
        // it here would emit `duplication-stopped` and take the still-working
        // primary route down with it. The outcome is reported as what it is:
        // the mirrors each failed on their own events, and `active_routes`
        // shows this engine on the primary alone.
        // SAFETY: Stop on a started client; errors are not actionable, the
        // client is being dropped either way.
        unsafe {
            let _ = client.Stop();
        }
        drop(capture);
        drop(client);
        reason = hold_after_lost_copies(shared);
        shared.shutdown.store(true, Ordering::Relaxed);
        for mirror in &shared.mirrors {
            mirror.wake();
        }
        // No client to stop a second time: it is gone, which was the point.
        join_render_threads(shared, app, render_threads);
        return Ok(reason);
    }
    // Release the render threads before waiting for them. This flag is the only
    // thing `pump_render` returns on, and a process exit or a capture error ends
    // the loop above without `stop()` ever having been called — joining first
    // would wait forever on threads that are happily playing silence, leaking the
    // engine, its threads and the mirror devices they hold open.
    shared.shutdown.store(true, Ordering::Relaxed);
    // Wake the render threads for the same reason the registry does when a
    // route is stopped: one of them may be parked on a quiet source, waiting on
    // its own thread, and this thread is about to join it.
    for mirror in &shared.mirrors {
        mirror.wake();
    }
    // SAFETY: Stop on a started client; errors during shutdown are ignored.
    unsafe {
        let _ = client.Stop();
    }
    join_render_threads(shared, app, render_threads);
    Ok(reason)
}

/// Tracks whether the synchronized-start gate has been opened.
struct StartGate {
    opened_at: Instant,
    opened: bool,
}

/// Open the start gate once every mirror is initialized and holds one base
/// pipeline of pre-roll, or after the timeout (a silent app never fills it, and
/// starting un-synced while silence plays is harmless).
///
/// Only the *base* latency is required, not each mirror's full target: a
/// delay is realized by silence placed ahead of the mirror's audio (see
/// `pump_render`), which needs no captured history, so a large configured
/// delay never stalls the start.
fn open_gate_when_ready(shared: &Arc<EngineShared>, gate: &mut StartGate) {
    if gate.opened {
        return;
    }
    let pre_roll = shared.latency_frames * shared.block_align;
    let all_ready = shared.ready_count.load(Ordering::Relaxed) == shared.mirrors.len();
    let all_filled = all_ready
        && shared
            .mirrors
            .iter()
            .filter(|m| m.enabled.load(Ordering::Relaxed))
            .all(|m| m.buffered_bytes() >= pre_roll);
    if all_filled || gate.opened_at.elapsed() >= PRE_ROLL_TIMEOUT {
        gate.opened = true;
        shared.go.store(true, Ordering::Relaxed);
        // The mirrors wait on their own threads rather than polling this flag,
        // so setting it is not by itself enough to release them: without the
        // wake each would sit out the rest of its backstop before starting.
        for mirror in &shared.mirrors {
            mirror.wake();
        }
        info!(
            "duplication for PID {} started, pre-roll took {:?}",
            shared.pid,
            gate.opened_at.elapsed()
        );
    }
}

/// Drain capture packets until shutdown, error, or process exit.
fn capture_packets(
    shared: &Arc<EngineShared>,
    capture: &IAudioCaptureClient,
    event: HANDLE,
    gate: &mut StartGate,
) -> ExitReason {
    match capture_packets_inner(shared, capture, event, gate) {
        Ok(reason) => reason,
        Err(e) => ExitReason::Error(e),
    }
}

fn capture_packets_inner(
    shared: &Arc<EngineShared>,
    capture: &IAudioCaptureClient,
    event: HANDLE,
    gate: &mut StartGate,
) -> Result<ExitReason, AudioError> {
    let com_err =
        |what: &str, e: windows::core::Error| AudioError::Api(format!("{what} failed: {e}"));
    // One estimate per engine, folded from the packets as they arrive and
    // published on a schedule. Owned here because this thread is its only
    // writer, and kept across packets because a level is a running measurement.
    let mut level = LevelTracker::default();
    loop {
        // SAFETY: valid event handle owned by this thread.
        let wait = unsafe { WaitForSingleObject(event, CAPTURE_WAIT_MS) };
        shared.capture_wakeups.fetch_add(1, Ordering::Relaxed);
        if shared.shutdown.load(Ordering::Relaxed) {
            return Ok(ExitReason::Stopped);
        }
        open_gate_when_ready(shared, gate);
        if shared.all_mirrors_lost() {
            // Every mirror is out of service: the pump has nothing left to
            // feed, and pumping keeps the loopback endpoint busy for copies
            // that will never wake up. Hand over to the hold (see
            // `capture_session`), which releases the client without taking
            // the primary route down.
            return Ok(ExitReason::AllMirrorsLost);
        }
        if wait == WAIT_TIMEOUT {
            // The loopback event only fires while the process actually plays
            // audio; use idle timeouts to notice process exit.
            if !process_is_running(shared.pid, shared.creation_time) {
                return Ok(ExitReason::ProcessExited);
            }
            continue;
        }

        loop {
            // SAFETY: packet query on a started capture client.
            let packet = unsafe {
                capture
                    .GetNextPacketSize()
                    .map_err(|e| com_err("GetNextPacketSize", e))?
            };
            if packet == 0 {
                break;
            }
            let mut data: *mut u8 = std::ptr::null_mut();
            let mut frames = 0u32;
            let mut flags = 0u32;
            // SAFETY: out params; the buffer is valid until ReleaseBuffer.
            if let Err(e) =
                unsafe { capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None) }
            {
                return Err(com_err("GetBuffer(capture)", e));
            }
            if frames > 0 && flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 == 0 {
                let bytes = frames as usize * shared.block_align;
                // SAFETY: GetBuffer guarantees `bytes` writable bytes.
                let chunk = unsafe { std::slice::from_raw_parts(data, bytes) };
                // Measured before the push and outside the ring, and published
                // in what the program produced (`measure_into`) rather than
                // what any one device was handed after its own gains.
                measure_into(&mut level, shared, chunk, frames);
                // Timestamp first, then the push, then the wake: a mirror that
                // runs on either of the last two must not conclude the source
                // is quiet on the strength of the packet it is already holding.
                note_audio(shared);
                for mirror in &shared.mirrors {
                    mirror.push(chunk, shared.block_align);
                    mirror.wake();
                }
            }
            // SAFETY: balances GetBuffer with the number of frames read.
            if let Err(e) = unsafe { capture.ReleaseBuffer(frames) } {
                return Err(com_err("ReleaseBuffer(capture)", e));
            }
        }
    }
}
