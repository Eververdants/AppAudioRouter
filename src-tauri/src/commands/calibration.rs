//! The delay wizard's test tone.
//!
//! One run at a time, on a blocking thread of its own, cancellable, and bounded:
//! the start command resolves when the whole sequence has played, so the
//! frontend's promise is "this burst is done" and the `calibration-tone` event
//! pair is the timeline. The run token is the point of the two commands — it is
//! what lets a start that lands *after* the user's cancel be refused instead of
//! played into a dialog that is already gone.
//!
//! Rust also ends a run nobody can report any more: `main.rs` calls
//! `audio::calibration::cancel_live_run` when a window hides or is destroyed,
//! because a webview that went away cannot ask.

use log::info;
use tauri::{AppHandle, State};

use crate::audio;

/// Play the delay-wizard's test tone on one device: `reps` short bursts with
/// pauses between them, each burst bracketed by a `calibration-tone` event
/// pair (`start` when its first frame is written, `end` when its last one is).
///
/// The wizard's round-robin drives one burst per call (`reps = 1`), drawing a
/// fresh random `lead_ms` each time so the pace stays unpredictable across the
/// whole session, and a short `tail_ms` between calls; the defaults describe a
/// standalone single-device sequence. Values are clamped inside the player.
///
/// `run` names the wizard's run, and it is what lets a start that arrives *after*
/// the user's cancel be refused instead of played: the cancel lands on the IPC
/// thread while this command's body is still queued, so without a run to compare,
/// the start would clear the cancel it had just caused and sound into a dialog
/// that is gone. Passing it is precise — only that run is refused. A caller that
/// names no run still gets the race closed, by the coarser rule in
/// [`audio::calibration::CalibrationState::begin`]; see
/// [`audio::calibration::NO_RUN_TOKEN`].
///
/// Resolves when the whole sequence has played, so the frontend treats the
/// command's promise as "this burst is done" and the events as the timeline
/// itself. Only one run exists at a time; `calibration_cancel` ends the
/// current one within a backstop interval.
#[tauri::command]
pub async fn calibration_start(
    device_id: String,
    reps: Option<usize>,
    lead_ms: Option<usize>,
    tail_ms: Option<usize>,
    run: Option<u64>,
    app: AppHandle,
    state: State<'_, audio::calibration::CalibrationState>,
) -> Result<(), String> {
    info!(
        "cmd: calibration_start device={device_id} reps={reps:?} lead={lead_ms:?} tail={tail_ms:?} run={run:?}"
    );
    audio::routing::validate_device_id(&device_id).map_err(|e| e.to_string())?;
    let run = run.unwrap_or(audio::calibration::NO_RUN_TOKEN);
    let admitted = match state.begin(run) {
        Ok(admitted) => admitted,
        Err(refusal) => {
            if refusal == audio::calibration::Refusal::Cancelled {
                // The wizard is already gone by definition, so this line is the only
                // trace the burst was stopped rather than never asked for.
                info!(
                    "calibration start for run {run} was cancelled before it was admitted; refusing it"
                );
            }
            return Err(refusal.message().to_string());
        }
    };
    let (guard, cancel_epoch) = state.worker_tokens();
    tokio::task::spawn_blocking(move || {
        // The guard hands the busy flag back on every exit, panics included.
        let _guard = guard;
        audio::calibration::play_test_tone(
            &device_id,
            reps.unwrap_or(audio::calibration::TONE_REPS_DEFAULT),
            lead_ms.unwrap_or(audio::calibration::LEAD_MS_DEFAULT),
            tail_ms.unwrap_or(audio::calibration::TAIL_MS_DEFAULT),
            &app,
            &cancel_epoch,
            admitted,
        )
    })
    .await
    .map_err(|e| format!("calibration worker failed: {e}"))?
    .map_err(|e| e.to_string())
}

/// Ask the running calibration to stop. The start command resolves with an
/// error shortly after; the frontend that called cancel simply ignores it.
///
/// `run` names the run the caller means, which is what lets a start still in
/// flight for *that* run be refused when it lands. The burst that is sounding is
/// stopped whichever run the caller named: a user who said stop is heard, and the
/// token only decides what may still begin.
#[tauri::command]
pub fn calibration_cancel(
    run: Option<u64>,
    state: State<'_, audio::calibration::CalibrationState>,
) {
    state.cancel(run.unwrap_or(audio::calibration::NO_RUN_TOKEN));
    // The generation is read after the cancel it just took, because that number is
    // the only thing this side can say about the start/cancel race: it is what tells
    // a refused start from a burst nobody asked to stop, in a log line the wizard's
    // own dialog has already walked away from.
    info!(
        "cmd: calibration_cancel run={run:?} generation={}",
        state.generation()
    );
}
