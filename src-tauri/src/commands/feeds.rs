//! Feeds: one program's output sent into another program's input, and the
//! loopback pair that carries them.
//!
//! A feed is **additional**, never a move. The source keeps playing wherever it
//! already plays and gains one extra destination that is not a device (the tap,
//! see [`super::taps`]), while the target's capture endpoint is pinned to the
//! carrier's recording side — which is what makes it record the source. Both
//! halves are written down so they can be handed back, and the rule goes into the
//! feed memory so it survives a restart.
//!
//! The asymmetry the rest of the module depends on: taking a feed back releases
//! the target's **capture** half and must never touch the source's render side,
//! and a feed without a configured carrier is recorded anyway and reports why it
//! is quiet. This app ships no virtual sound card, so the pair is the user's to
//! pick.

use log::{info, warn};
use tauri::{AppHandle, State};

use crate::audio;
use crate::audio::routing::PinnedRoutes;
use crate::config::{FeedCarrier, FeedCarrierConfig, FeedConfig};

use super::identity::require_exe_name;
use super::outcomes::released_cleanly;
use super::taps::sync_feed_tap;
use super::{FeedBlockReason, FeedOutcome};

// ------------------------------------------------------------------- feeds

/// The loopback endpoint pair that carries feeds.
#[tauri::command]
pub fn get_feed_carrier(carrier: State<'_, FeedCarrierConfig>) -> FeedCarrier {
    carrier.get()
}

/// Replace the carrier pair. Both halves may be null ("not configured").
#[tauri::command]
pub fn set_feed_carrier(
    render: Option<String>,
    capture: Option<String>,
    carrier: State<'_, FeedCarrierConfig>,
) -> Result<(), String> {
    info!("cmd: set_feed_carrier render={render:?} capture={capture:?}");
    if let Some(id) = render.as_deref() {
        audio::routing::validate_device_id(id).map_err(|e| e.to_string())?;
    }
    if let Some(id) = capture.as_deref() {
        audio::routing::validate_device_id(id).map_err(|e| e.to_string())?;
    }
    // A loopback pair is two different endpoints by definition: pointing both
    // halves at one endpoint makes a carrier that can be configured but can
    // never carry a feed anywhere.
    if let (Some(render), Some(capture)) = (render.as_deref(), capture.as_deref()) {
        if render.eq_ignore_ascii_case(capture) {
            return Err("the two halves of a loopback pair are different endpoints".to_string());
        }
    }
    carrier.set(render, capture)
}

/// Every remembered feed rule as `(source_exe, target_exe)` pairs.
#[tauri::command]
pub fn list_feeds(feeds: State<'_, FeedConfig>) -> Vec<(String, String)> {
    feeds.all()
}

/// Send one program's audio into another program's input.
///
/// A feed is **additional**, not a move: the source keeps playing wherever it
/// already plays — its device route, or the system default — and the engine
/// gets one extra destination that is not a device (the *tap*, see
/// `MirrorChannel::feed_tap`), writing the same captured audio into the
/// carrier's playback side. The target's capture endpoint is pinned to the
/// carrier's recording side, which is what makes it record the source. Both
/// halves are written down so they can be handed back, and the rule goes into
/// the feed memory so it survives a restart.
///
/// The one thing this must never do is take the source's own output away: the
/// per-app endpoint is a single slot per data flow, and pointing it at the
/// carrier is exactly what used to silence the programme on the device it was
/// playing on. The tap exists so that choice never has to be made.
// Tauri commands carry their State params in the signature, so the argument
// count is fixed by the framework.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn set_feed_target(
    source_pid: u32,
    source_exe: String,
    target_pid: u32,
    target_exe: String,
    feeds: State<'_, FeedConfig>,
    carrier: State<'_, FeedCarrierConfig>,
    pins: State<'_, PinnedRoutes>,
    app: AppHandle,
) -> Result<FeedOutcome, String> {
    info!("cmd: set_feed_target {source_exe} ({source_pid}) -> {target_exe} ({target_pid})");
    if source_pid == 0 || target_pid == 0 || source_pid == target_pid {
        return Err("a feed needs two distinct processes".to_string());
    }
    if source_exe.eq_ignore_ascii_case(&target_exe) {
        return Err("a program cannot be fed into itself".to_string());
    }
    // Both halves of the rule are keyed by executable name, and the pins that hold
    // the two endpoints are looked up by that name on the way out: a blank one
    // would be a feed nothing can ever remove.
    require_exe_name("the sending program of a feed", &source_exe)?;
    require_exe_name("the receiving program of a feed", &target_exe)?;
    // The rule is recorded first: an undeliverable feed is still the user's
    // decision, and the board shows it with the reason it is quiet. Recording
    // is cheap and idempotent — but a failure rollback may only undo what this
    // call added, so whether the rule pre-existed is snapshotted first: this
    // can be a re-establishment after the target relaunched, and erasing a
    // rule that was already on file would take back a feed the user set
    // earlier.
    let rule_pre_existed = feeds.contains(&source_exe, &target_exe);
    feeds.add(&source_exe, &target_exe)?;
    // The same snapshot for the source pin: another feed from this program may
    // already stand, and its pin is what resumes that feed's tap later.
    let source_pin_pre_existed = pins.feed_source_of(source_pid).is_some();

    let pair = carrier.get();
    let (Some(_), Some(capture)) = (pair.render.clone(), pair.capture.clone()) else {
        return Ok(FeedOutcome {
            delivered: false,
            reason: Some(FeedBlockReason::NoCarrier),
        });
    };

    // The capture half is the target's own endpoint, and the only one a feed
    // ever writes onto a program that is not its source.
    if let Err(e) =
        audio::routing::set_process_default_capture_device(&capture, target_pid, audio::Role::All)
            .await
    {
        // The frontend rolls its optimistic write back on an error, so a rule
        // this call recorded must go too, or the next launch would resurrect a
        // feed the UI does not show. A rule that pre-existed this call is left
        // alone: it was the user's before, and it survives a failed landing the
        // same way it survived the program's own restart. A removal that
        // itself fails has to be said out loud: the resurrecting rule is the
        // one failure nothing else here reports.
        if !rule_pre_existed {
            if let Err(recover) = feeds.remove(&source_exe, &target_exe) {
                warn!("the feed rule of {source_exe} -> {target_exe} stayed on file: {recover}");
            }
        }
        return Err(e.to_string());
    }
    pins.mark_feed_capture(target_pid, &target_exe);
    // The sending half is the tap, and the pin records that this programme is a
    // feed source — that is what a removal, a restart of the route, and a sweep
    // read.
    pins.mark_feed(source_pid, &source_exe);
    match sync_feed_tap(source_pid, &source_exe, &feeds, &carrier, &pins, &app).await {
        Ok(_) => Ok(FeedOutcome {
            delivered: true,
            reason: None,
        }),
        Err(e) => {
            // Nothing moves, so nothing may be left behind: the target's mic
            // must not stay pointed at a carrier that receives no audio, the
            // rule must not come back on the next launch, and the pin must not
            // outlive either. Another rule may still need the same capture
            // endpoint, so the release is guarded by what remains.
            let target_still_needed = feeds.all().iter().any(|(src, tgt)| {
                tgt.eq_ignore_ascii_case(&target_exe) && !src.eq_ignore_ascii_case(&source_exe)
            });
            if !target_still_needed && pins.feed_capture_of(target_pid).is_some() {
                // The wire did not land, so the target's capture side goes back —
                // but only a *clean* release may drop the book entry. Windows
                // refusing to hand the endpoint back would leave the program fixed
                // to the carrier with the board already gone: the same half-worked
                // state a removal reports by name, and it is said here the same
                // way rather than forgotten into silence. This command already
                // fails with the landing's own error, so the log is the honest
                // channel for the residue.
                if released_cleanly(
                    audio::routing::release_process_default_devices_flow(
                        vec![target_pid],
                        audio::Role::All,
                        true,
                    )
                    .await,
                    "feed target",
                ) {
                    pins.forget_feed_capture(target_pid);
                } else if let Some(exe) = pins.feed_capture_exe_of(target_pid) {
                    warn!("the capture endpoint of {exe} stayed fixed to the carrier after a failed feed");
                }
            }
            // The pin and the rule go only if this call created them: a source
            // that already fed another program keeps its pin (that feed's tap
            // is resumed through it), and a pre-existing rule survives like it
            // survives the target's own restart.
            if !source_pin_pre_existed {
                pins.forget_feed_source(source_pid);
            }
            if !rule_pre_existed {
                if let Err(recover) = feeds.remove(&source_exe, &target_exe) {
                    warn!(
                        "the feed rule of {source_exe} -> {target_exe} stayed on file: {recover}"
                    );
                }
            }
            // The engine restart that failed may have taken the route's own
            // engine down with it: put it back without the tap so the devices
            // keep playing even though the feed did not land.
            if let Err(retry) =
                sync_feed_tap(source_pid, &source_exe, &feeds, &carrier, &pins, &app).await
            {
                warn!(
                    "could not put the route of PID {source_pid} back after a failed feed: {retry}"
                );
            }
            Err(e)
        }
    }
}

/// Take one feed rule back: drop it from the memory, take its tap off the
/// source's engine and release the target's capture endpoint.
///
/// A source that is also routed keeps playing on its devices throughout: the
/// tap is the only thing that goes, and the engine is restarted with the same
/// route minus that one destination.
///
/// Returns the programs that stay fixed to the carrier because Windows refused
/// to hand their endpoint back. The rule and the wire are gone either way — the
/// user asked for that, and the memory must not resurrect a feed they removed —
/// but a removal that quietly half-worked is invisible unless it is said.
#[tauri::command]
pub async fn remove_feed_target(
    source_pid: u32,
    target_pid: u32,
    feeds: State<'_, FeedConfig>,
    carrier: State<'_, FeedCarrierConfig>,
    pins: State<'_, PinnedRoutes>,
    app: AppHandle,
) -> Result<Vec<String>, String> {
    info!("cmd: remove_feed_target {source_pid} -> {target_pid}");
    // The same bound `set_feed_target` imposes on its way in: a feed has two real
    // processes or it is not a feed, and PID 0 (the system-sounds session) is one
    // the release walk below will not answer for.
    if source_pid == 0 || target_pid == 0 {
        return Err("a feed needs two real processes".to_string());
    }
    // The executable names decide which memory rule this is. The pins record
    // them for delivered feeds; a feed that was never delivered — recorded
    // with no carrier, or while its source was routed — has no pin to ask, so
    // the live process is asked directly. Without that fallback the rule
    // would stay in the memory while the board dropped it, and the next
    // launch would put it back.
    let source_exe = pins
        .feed_source_exe_of(source_pid)
        .or_else(|| audio::sessions::get_process_exe_name(source_pid))
        .unwrap_or_default();
    let target_exe = pins
        .feed_capture_exe_of(target_pid)
        .or_else(|| audio::sessions::get_process_exe_name(target_pid))
        .unwrap_or_default();
    if source_exe.is_empty() || target_exe.is_empty() {
        // Neither the pin nor the process can say which program this wire
        // belonged to, so the rule cannot be found and no endpoint can be
        // named: the memory would go on resurrecting a feed the board has
        // already dropped. Answering `Ok` here would report a removal that
        // did not happen — and this command's answer is exactly the channel
        // that carries "what is still stuck" to the user.
        return Err(format!(
            "the program behind this feed (PID {source_pid} in, PID {target_pid} out) is gone, \
             so its rule cannot be found to be forgotten — clear the remembered feed instead"
        ));
    }
    feeds.remove(&source_exe, &target_exe)?;
    // What is still on the books decides what this run may let go: a rule
    // from the same source or into the same target shares the endpoint pin,
    // and releasing it here would silence the feed that remains.
    let remaining = feeds.all();
    let source_still_needed = remaining
        .iter()
        .any(|(src, _)| src.eq_ignore_ascii_case(&source_exe));
    let target_still_needed = remaining
        .iter()
        .any(|(_, tgt)| tgt.eq_ignore_ascii_case(&target_exe));
    // The sending half is a tap inside the source's engine, not an endpoint
    // assignment, so it comes off by restarting that engine without it. While
    // another rule from the same source stands, the tap is exactly what has to
    // stay — restarting for it would only interrupt the audio.
    let mut stuck = Vec::new();
    if !source_still_needed && pins.feed_source_of(source_pid).is_some() {
        pins.forget_feed_source(source_pid);
        if let Err(e) = sync_feed_tap(source_pid, &source_exe, &feeds, &carrier, &pins, &app).await
        {
            warn!("could not take the feed tap of {source_exe} off: {e}");
        }
    }
    // The receiving half is the target's own capture endpoint and does belong to
    // the feed: a target with no capture pin of ours is left alone, and one that
    // Windows will not hand back is named.
    //
    // A pin comes off the book only when Windows accepted the clear. Forgetting
    // it on a refusal leaves that assignment with nothing on our side pointing
    // at it — the board has already dropped the wire, so no later command comes
    // back for it, and the program is left on the carrier with nothing but the
    // settings reset to explain why. So the pin stays, and the name goes into
    // the log line the frontend writes.
    if pins.feed_capture_of(target_pid).is_some() && !target_still_needed {
        if released_cleanly(
            audio::routing::release_process_default_devices_flow(
                vec![target_pid],
                audio::Role::All,
                true,
            )
            .await,
            "feed target",
        ) {
            pins.forget_feed_capture(target_pid);
        } else if !target_exe.is_empty() {
            stuck.push(target_exe);
        }
    }
    Ok(stuck)
}
