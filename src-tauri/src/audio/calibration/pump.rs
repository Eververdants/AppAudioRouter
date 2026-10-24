//! The render loop: feeding the device from the schedule, paced to a fixed
//! padding target.
//!
//! [`pump`] is the only place a burst's frames reach an endpoint, and the only
//! place the two `calibration-tone` markers are emitted — `start` on the first
//! write of a burst, `end` on its last one, so the pair brackets exactly the tone
//! the frontend times. Its pacing is the engine's own shape (event-driven shared
//! client, topped up towards [`PADDING_TARGET_MS`]) so a burst experiences the
//! same write-ahead depth a real copy would.
//!
//! Every wait here is woken by the device's render event or bounded by
//! [`WAIT_BACKSTOP_MS`], which exists so a cancelled run cannot linger between
//! writes; the cancel flag [`super::state`] sets is checked on both exits, and a
//! wait that fails outright ends the run rather than spinning it.

use std::sync::atomic::{AtomicBool, Ordering};

use log::warn;
use serde_json::json;
use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::{GetLastError, HANDLE, WAIT_FAILED};
use windows::Win32::Media::Audio::{IAudioClient, IAudioRenderClient, AUDCLNT_BUFFERFLAGS_SILENT};
use windows::Win32::System::Threading::WaitForSingleObject;

use crate::audio::AudioError;

use super::schedule::{segment_len, Segment, PADDING_TARGET_MS};

/// Backstop for the wait on the render event: the event fires once per device
/// period while the stream is running; the timeout only bounds how long a
/// cancelled run can linger between writes.
const WAIT_BACKSTOP_MS: u32 = 250;

/// Feed the device from the segment list, paced to a fixed padding target.
///
/// Every wait in this loop is woken by the device's render event (once per
/// period) or bounded by the backstop timeout, which exists so a cancelled run
/// cannot linger between writes; the cancel flag is checked on both exits, and a
/// wait that fails outright ends the run rather than spinning it (see below).
// Tauri commands carry their State params in the signature, so the argument
// count is fixed by the framework — same allowance the route command carries.
#[allow(clippy::too_many_arguments)]
pub(super) fn pump(
    client: &IAudioClient,
    render: &IAudioRenderClient,
    schedule: &[Segment],
    burst: &[f32],
    channels: usize,
    sample_rate: u32,
    buffer_frames: usize,
    event: HANDLE,
    cancel: &AtomicBool,
    app: &AppHandle,
) -> Result<(), AudioError> {
    let com_err =
        |what: &str, e: windows::core::Error| AudioError::Api(format!("{what} failed: {e}"));
    // The buffer level the pump keeps: the write-ahead every burst sits behind,
    // common to every device this player runs against.
    let target =
        (PADDING_TARGET_MS * sample_rate as usize / 1000).min(buffer_frames.saturating_sub(1));

    let mut seg_idx = 0usize;
    let mut seg_frame = 0usize;
    let mut rep = 0usize;
    let mut start_marked = false;
    let mut end_marked = false;

    while seg_idx < schedule.len() {
        if cancel.load(Ordering::SeqCst) {
            return Err(AudioError::Api("calibration cancelled".to_string()));
        }
        // SAFETY: valid event handle; signalled once per device period while
        // the stream runs, and a timeout is the expected answer between periods.
        let waited = unsafe { WaitForSingleObject(event, WAIT_BACKSTOP_MS) };
        if waited == WAIT_FAILED {
            // The handle is not waitable any more, so the wait returns at once
            // instead of pacing the loop: carrying on would spin this thread at
            // full tilt while writing the burst as fast as the buffer allows,
            // which is the opposite of a predictable measurement.
            // SAFETY: GetLastError only reads this thread's last-error slot.
            let code = unsafe { GetLastError() };
            return Err(AudioError::Api(format!(
                "WaitForSingleObject(calibration) failed: 0x{:08X}",
                code.0
            )));
        }
        if cancel.load(Ordering::SeqCst) {
            return Err(AudioError::Api("calibration cancelled".to_string()));
        }
        // SAFETY: padding query on a started render client.
        let padding = unsafe {
            client
                .GetCurrentPadding()
                .map_err(|e| com_err("GetCurrentPadding", e))?
        } as usize;
        let free = buffer_frames.saturating_sub(padding);
        let mut budget = target.saturating_sub(padding).min(free);

        while budget > 0 && seg_idx < schedule.len() {
            let remaining = segment_len(&schedule[seg_idx]) - seg_frame;
            if remaining == 0 {
                seg_idx += 1;
                seg_frame = 0;
                continue;
            }
            let take = remaining.min(budget);
            match &schedule[seg_idx] {
                Segment::Silence(_) => {
                    // SAFETY: silent frames need no data access; the buffer is
                    // valid until ReleaseBuffer.
                    unsafe {
                        render
                            .GetBuffer(take as u32)
                            .map_err(|e| com_err("GetBuffer(silence)", e))?;
                        render
                            .ReleaseBuffer(take as u32, AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)
                            .map_err(|e| com_err("ReleaseBuffer(silence)", e))?;
                    }
                }
                Segment::Tone(_) => {
                    if !start_marked {
                        start_marked = true;
                        // The start marker rides on the first write of the
                        // burst: from here the tone is on its way to the DAC.
                        // It is the measurement, not a courtesy: a marker the
                        // window never got leaves the wizard scoring the next
                        // tap against the previous burst, so the failure is
                        // logged rather than swallowed.
                        if let Err(e) = app.emit(
                            "calibration-tone",
                            json!({ "index": rep, "phase": "start" }),
                        ) {
                            warn!("could not deliver the tone start marker: {e}");
                        }
                    }
                    // SAFETY: copy of exactly `take` frames into the buffer
                    // returned by GetBuffer; valid until ReleaseBuffer.
                    unsafe {
                        let dst = render
                            .GetBuffer(take as u32)
                            .map_err(|e| com_err("GetBuffer(tone)", e))?;
                        let dst =
                            core::slice::from_raw_parts_mut(dst.cast::<f32>(), take * channels);
                        dst.copy_from_slice(
                            &burst[seg_frame * channels..(seg_frame + take) * channels],
                        );
                        render
                            .ReleaseBuffer(take as u32, 0)
                            .map_err(|e| com_err("ReleaseBuffer(tone)", e))?;
                    }
                    if seg_frame + take >= segment_len(&schedule[seg_idx]) && !end_marked {
                        end_marked = true;
                        // The end marker rides on the burst's last write, so
                        // the two markers bracket exactly the burst.
                        if let Err(e) =
                            app.emit("calibration-tone", json!({ "index": rep, "phase": "end" }))
                        {
                            warn!("could not deliver the tone end marker: {e}");
                        }
                    }
                }
            }
            seg_frame += take;
            budget -= take;
            if seg_frame >= segment_len(&schedule[seg_idx]) {
                if matches!(schedule[seg_idx], Segment::Tone(_)) {
                    rep += 1;
                    start_marked = false;
                    end_marked = false;
                }
                seg_idx += 1;
                seg_frame = 0;
            }
        }
    }
    Ok(())
}
