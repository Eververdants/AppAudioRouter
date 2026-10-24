//! The render cycle: one device's period, and the park that ends it.
//!
//! [`render_run`] waits for the synchronized start, starts the client and hands
//! over to [`pump_render`], which is the only place this engine touches a device
//! buffer: settle the backlog on its target *before* handing frames over (a
//! shortfall is made up with silence placed *ahead* of the audio, which is what a
//! delay means), then write the next period with the three gains multiplied —
//! source level × device share × session compensation.
//!
//! [`park_mirror`] is the idle rule: a mirror whose source went quiet is `Stop`ped
//! rather than written at with silence forever, and it may only park once the idle
//! window *plus its own pipeline depth* has passed, so a park only ever drops
//! silence. Both waits are thread parks with a backstop, never a poll.

use std::sync::atomic::Ordering;

use tauri::AppHandle;
use windows::Win32::Foundation::WAIT_TIMEOUT;
use windows::Win32::Media::Audio::AUDCLNT_BUFFERFLAGS_SILENT;
use windows::Win32::System::Threading::WaitForSingleObject;

use crate::audio::AudioError;

use super::format::apply_gain;
use super::mirror::MirrorChannel;
use super::mix::{session_compensation, source_gain, target_frames, volume_gain};
use super::render::{fail_mirror, RenderSession};
use super::shared::{mirror_quiet, source_quiet, EngineShared};
use super::{GATE_POLL, PARK_POLL, RENDER_WAIT_MS};

/// Wait for the synchronized-start gate, then run the render loop.
pub(super) fn render_run(
    shared: &EngineShared,
    mirror: &MirrorChannel,
    session: RenderSession,
    app: &AppHandle,
) {
    // Publish this thread before the first of the two waits that can park it.
    // The gate below and the idle park in the render loop are both ended by a
    // wake aimed at this thread, so it has to be reachable by the time either
    // can block; a wake arriving earlier leaves a token that the next park
    // consumes instead of blocking, and each wait re-checks its condition
    // afterwards, so no wakeup is lost.
    *mirror.worker.lock().unwrap_or_else(|e| e.into_inner()) = Some(std::thread::current());
    // A slow device (e.g. Bluetooth connecting for the first time) holds the
    // gate closed; the other mirrors wait for it instead of running ahead.
    // Waiting on the thread rather than polling: this window is bounded by the
    // pre-roll timeout, and a polling loop spends it waking five hundred times
    // a second per mirror to re-read a flag that has not changed.
    while !shared.go.load(Ordering::Relaxed) {
        if shared.shutdown.load(Ordering::Relaxed) {
            return;
        }
        std::thread::park_timeout(GATE_POLL);
    }
    if shared.shutdown.load(Ordering::Relaxed) {
        return;
    }
    // SAFETY: Start on a fully initialized client.
    if let Err(e) = unsafe { session.client.Start() } {
        fail_mirror(
            shared,
            mirror,
            app,
            AudioError::Api(format!("Start(render) failed: {e}")),
        );
        return;
    }

    let result = pump_render(shared, mirror, &session);
    // SAFETY: Stop on a started client; errors during shutdown are ignored.
    unsafe {
        let _ = session.client.Stop();
    }
    if let Err(e) = result {
        fail_mirror(shared, mirror, app, e);
    }
}

/// Event-driven render cycle.
///
/// Every mirror keeps a backlog (device buffer + ring) of its own target
/// between the capture tap and playback — the shared base latency plus the
/// group shift plus its delay compensation (see `target_frames`) — so all
/// mirrors play the same sample at the same moment, offset by exactly the
/// configured delays. A device whose clock runs slow crosses the trim
/// threshold and drops its oldest frames by the drift amount; a fast device
/// briefly writes silence instead. Hardware latency (e.g. a Bluetooth codec's
/// buffer) adds on top of this and is outside software control.
fn pump_render(
    shared: &EngineShared,
    mirror: &MirrorChannel,
    session: &RenderSession,
) -> Result<(), AudioError> {
    let com_err =
        |what: &str, e: windows::core::Error| AudioError::Api(format!("{what} failed: {e}"));
    // Reused across cycles so the render thread allocates nothing per period;
    // local to this thread and cleared on every pop, so a park in between
    // cannot carry stale frames into the next device buffer.
    let mut chunk: Vec<u8> = Vec::new();
    loop {
        // SAFETY: valid event handle owned by this thread.
        let wait = unsafe { WaitForSingleObject(session.event, RENDER_WAIT_MS) };
        mirror.wakeups.fetch_add(1, Ordering::Relaxed);
        if shared.shutdown.load(Ordering::Relaxed) {
            return Ok(());
        }
        // Nothing buffered and nothing arriving: stop feeding the device, which
        // is the only way to stop it signalling this thread every period. The
        // pipeline is empty, so the device is playing the silence that was
        // written into it, and stopping is silent too.
        if mirror.buffered_bytes() == 0 && mirror_quiet(shared, mirror) {
            park_mirror(shared, mirror, session)?;
            if shared.shutdown.load(Ordering::Relaxed) {
                return Ok(());
            }
            continue;
        }
        if wait == WAIT_TIMEOUT {
            continue;
        }
        // SAFETY: padding query on a started render client.
        let padding = unsafe {
            session
                .client
                .GetCurrentPadding()
                .map_err(|e| com_err("GetCurrentPadding", e))?
        } as usize;
        let target = target_frames(shared, mirror);
        // Settle the backlog on its target *before* handing frames to the
        // device. The total (device buffer + ring) is unchanged by the hand-off,
        // so correcting first is equivalent to correcting afterwards — except
        // that a shortfall is then made up with silence placed *ahead* of the
        // audio, which is what a delay means. Correcting afterwards would play
        // the audio early and the silence late, so a raised delay (or an
        // under-filled pre-roll) would not take effect until the next buffer.
        let total = padding + mirror.buffered_bytes() / shared.block_align;
        if total > target + shared.trim_slack_frames {
            // Writes are capped at the target, so padding never exceeds it and
            // the excess always fits inside the ring.
            mirror.drop_oldest(total - target, shared.block_align);
        } else if total < target {
            mirror.prepend_silence(target - total, shared.block_align);
        }
        let free = session.buffer_frames.saturating_sub(padding);
        let allowed = target.saturating_sub(padding).min(free);
        if allowed > 0 {
            mirror.pop(allowed, shared.block_align, &mut chunk);
            if chunk.is_empty() {
                // The pipeline ran dry (fast clock or a silent source); keep
                // the engine fed with silence until data returns. This must run
                // even when the device buffer already holds frames (padding > 0)
                // — otherwise that queued audio plays out underrun with no
                // fresh data written behind it, which audibly glitches.
                // SAFETY: silent frames need no data access; the buffer is
                // valid until ReleaseBuffer.
                unsafe {
                    session
                        .render
                        .GetBuffer(allowed as u32)
                        .map_err(|e| com_err("GetBuffer(render)", e))?;
                    session
                        .render
                        .ReleaseBuffer(allowed as u32, AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)
                        .map_err(|e| com_err("ReleaseBuffer(render)", e))?;
                }
            } else {
                // All three gains are applied here, the one place where the
                // app's audio is in our hands: the chunk is in the capture
                // format, which is also what this mirror's render client was
                // initialized with, so the device gets the shape it expects.
                // The program's own level is a property of the source, the
                // device's share is a property of where this copy is going,
                // and the session compensation undoes the session volume the
                // capture has already been through — so they multiply.
                apply_gain(
                    &mut chunk,
                    shared.sample,
                    source_gain(shared)
                        * volume_gain(shared, mirror)
                        * session_compensation(shared),
                );
                let frames = (chunk.len() / shared.block_align) as u32;
                // SAFETY: copy of exactly frames * block_align bytes into the
                // buffer returned by GetBuffer.
                unsafe {
                    let dst = session
                        .render
                        .GetBuffer(frames)
                        .map_err(|e| com_err("GetBuffer(render)", e))?;
                    std::ptr::copy_nonoverlapping(chunk.as_ptr(), dst, chunk.len());
                    session
                        .render
                        .ReleaseBuffer(frames, 0)
                        .map_err(|e| com_err("ReleaseBuffer(render)", e))?;
                }
            }
        }
    }
}

/// Stop a mirror's render client and wait for its source to come back.
///
/// An event-driven render client is signalled once per device period for as
/// long as it is started, whether or not it has anything to play. Writing
/// silence at it forever therefore keeps the endpoint busy and this thread
/// waking about a hundred times a second per mirror, which is what a routed app
/// that is not currently making a sound used to cost. `Stop` takes the client
/// out of the engine's mix, and no further events arrive until it is started
/// again.
///
/// This only ever drops silence. The caller parks once the pipeline is empty
/// and the source has been quiet for `SOURCE_IDLE_MS` plus this mirror's own
/// pipeline depth (see `mirror_quiet`), and a Silent packet is never pushed
/// into a ring to begin with, so nothing audible is discarded; the silence the
/// endpoint still holds makes the stop inaudible as well, and the restart
/// resumes from silence rather than from a click.
fn park_mirror(
    shared: &EngineShared,
    mirror: &MirrorChannel,
    session: &RenderSession,
) -> Result<(), AudioError> {
    // SAFETY: Stop on a started client; errors here are not actionable, the
    // park still holds and the next Start reports the real failure.
    unsafe {
        let _ = session.client.Stop();
    }
    loop {
        // The park is armed before the condition is re-checked, so a packet
        // landing between the caller's check and this call still leaves a token
        // that returns immediately. The timeout is a backstop for a wakeup that
        // never arrives, not the mechanism that ends the wait.
        std::thread::park_timeout(PARK_POLL);
        if shared.shutdown.load(Ordering::Relaxed) {
            return Ok(());
        }
        if mirror.buffered_bytes() > 0 || !source_quiet(shared) {
            break;
        }
    }
    // Rebuilding the pipeline depth is left to the next pass of the caller's
    // loop, which settles the backlog before handing anything to the device.
    // SAFETY: Start on a stopped client.
    if let Err(e) = unsafe { session.client.Start() } {
        return Err(AudioError::Api(format!(
            "Start(render) after idle failed: {e}"
        )));
    }
    Ok(())
}
