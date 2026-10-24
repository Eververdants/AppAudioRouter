//! The feed tap: the one destination of a duplication engine that is not a
//! device.
//!
//! The tap is what makes "send this program's audio into that program's input"
//! cost the source nothing: the engine writes the same captured audio a second
//! time into the carrier's playback side, and the program's own device output is
//! untouched.
//!
//! These helpers are shared by the two paths that need them, which is why they
//! live beside neither: `apply_route` carries the tap into the engine it starts,
//! `stop_route` and the stale sweep put it back on an engine of its own once the
//! route is gone, and `set_feed_target` / `remove_feed_target` add or drop it. An
//! engine's mirror list is fixed for its lifetime, so a tap comes on or off only
//! by restarting that engine with exactly the route it already had — which is
//! what [`sync_feed_tap`] asks the engine for before it touches anything.

use log::{info, warn};
use tauri::{AppHandle, Manager};

use crate::audio;
use crate::audio::duplication::DuplicationManager;
use crate::audio::routing::PinnedRoutes;
use crate::config::{FeedCarrierConfig, FeedConfig};

/// The carrier endpoint a feed tap writes into, when `exe` sends at least one
/// feed and both halves of the carrier are configured.
///
/// `None` covers the two quiet cases on purpose: a programme that sends nothing
/// has no tap, and a feed without a carrier is recorded but cannot move sound.
pub(super) fn feed_tap_for(
    exe: &str,
    feeds: &FeedConfig,
    carrier: &FeedCarrierConfig,
) -> Option<String> {
    let pair = carrier.get();
    let render = pair.render?;
    pair.capture.as_ref()?;
    feeds
        .all()
        .iter()
        .any(|(source, _)| source.eq_ignore_ascii_case(exe))
        .then_some(render)
}

/// The route `pid` is serving right now, as the engine knows it.
///
/// The engine is authoritative while it runs; without one, a single-device
/// route lives only on the book (`PinnedRoutes`), because Windows plays that
/// endpoint itself and no engine exists for it. `None` means the programme is
/// not routed at all — the normal state of a programme that only feeds.
fn route_targets_of(
    duplications: &DuplicationManager,
    pins: &PinnedRoutes,
    pid: u32,
) -> Option<(String, Vec<String>)> {
    if let Some(targets) = duplications.device_targets_of(pid) {
        return Some(targets);
    }
    pins.device_of(pid).map(|device| (device, Vec::new()))
}

/// Bring `pid`'s engine in line with the feed memory: one tap while the
/// programme sends a feed through a configured carrier, none otherwise.
///
/// A tap is added or removed by restarting the engine with the same route,
/// because an engine's mirror list is fixed for its lifetime. The route's own
/// devices come back exactly as they were (`device_targets_of`), so restarting
/// for a feed never changes what the user's devices play.
pub(super) async fn sync_feed_tap(
    pid: u32,
    exe: &str,
    feeds: &FeedConfig,
    carrier: &FeedCarrierConfig,
    pins: &PinnedRoutes,
    app: &AppHandle,
) -> Result<u64, String> {
    let tap = feed_tap_for(exe, feeds, carrier);
    let duplications = app.state::<DuplicationManager>();
    let targets = route_targets_of(&duplications, pins, pid);
    // Nothing to do: an engine is already serving this route with exactly this
    // tap. Restarting it would put a gap in the programme's sound for a change
    // that is not one — adding a second feed from the same source, or taking one
    // of two away, leaves the tap where it is.
    if targets.is_some() && duplications.feed_tap_of(pid) == tap {
        return Ok(0);
    }
    let exe = exe.to_string();
    let app = app.clone();
    tokio::task::spawn_blocking(move || {
        let duplications = app.state::<DuplicationManager>();
        match targets {
            Some((primary, mirrors)) => {
                if mirrors.is_empty() && tap.is_none() {
                    // An engine with no copies and no tap has nothing to do: a
                    // single-device route is Windows' own endpoint.
                    duplications.stop(pid);
                    return Ok(0);
                }
                duplications
                    .start(pid, &exe, &primary, mirrors, tap, &app)
                    .map_err(|e| e.to_string())
            }
            None => match tap {
                Some(tap) => {
                    // Unrouted, but feeding: the engine's primary is only the
                    // delay baseline, and the engine never writes it — the
                    // programme keeps playing where Windows has it.
                    let primary = audio::devices::get_default_render_device()
                        .map(|device| device.id)
                        .unwrap_or_default();
                    duplications
                        .start(pid, &exe, &primary, Vec::new(), Some(tap), &app)
                        .map_err(|e| e.to_string())
                }
                None => {
                    duplications.stop(pid);
                    Ok(0)
                }
            },
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Put the feed taps of `exe` back on after its engine was taken down with a
/// route.
///
/// A feed now outlives the device route it was added alongside: the tap is the
/// wire into the carrier, and stopping a route must not cut it. The rules
/// themselves are the feed memory's; the pins say which processes are sending.
pub(super) async fn resume_feed_taps(
    exe: &str,
    feeds: &FeedConfig,
    carrier: &FeedCarrierConfig,
    pins: &PinnedRoutes,
    app: &AppHandle,
) {
    if feed_tap_for(exe, feeds, carrier).is_none() {
        return;
    }
    for (feed_pid, source_exe) in pins.feed_source_pins() {
        if !source_exe.eq_ignore_ascii_case(exe) {
            continue;
        }
        // `feed_source_pins` hands out only the pins that still speak for a live
        // process, so nothing below can start an engine through a pid the kernel
        // has since handed on.
        match sync_feed_tap(feed_pid, &source_exe, feeds, carrier, pins, app).await {
            Ok(_) => info!("feed of PID {feed_pid} is back on its carrier"),
            Err(e) => warn!("could not put the feed of PID {feed_pid} back on: {e}"),
        }
    }
}
