//! The ledger that keeps a walk which could not name an endpoint from reading
//! that silence as removal.
//!
//! A synchronisation pass that skipped a device cannot tell a skipped endpoint
//! from a removed one, and pruning on that reading unregisters the watchers of
//! sessions still playing. The correction is to *ask* — the exact-id probe here
//! ([`endpoint_probe`]) consults the audio service itself, and only
//! `AUDCLNT_E_DEVICE_INVALIDATED` (or an inactive state) proves a departure; a
//! transient service failure proves nothing. Only an endpoint that cannot be
//! asked at all rides on a bounded deferral, so a permanently flaky entry cannot
//! hold a COM registration for the rest of the run either.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use std::time::Instant;

use log::warn;
use windows::core::{HRESULT, PCWSTR};
use windows::Win32::Media::Audio::{
    AudioSessionStateExpired, IMMDeviceEnumerator, AUDCLNT_E_DEVICE_INVALIDATED, DEVICE_STATE,
    DEVICE_STATE_ACTIVE,
};

use super::callbacks::WatchedSession;
use super::walk::DeviceRef;

/// How many incomplete passes one endpoint that cannot be asked about may ride
/// on before its absence is accepted.
const MAX_DEFERRED_ABSENCE_PASSES: u32 = 5;
/// The monotonic-clock bound on the same deferral, for a graph that changes
/// slowly enough that the pass count never gets there first.
const DEFERRED_ABSENCE_GRACE_MS: u64 = 60_000;

/// A monotonic clock in milliseconds, for bounding a deferral.
///
/// `Instant` and not the wall clock: an NTP correction, or the machine waking
/// from sleep, must not lengthen or shorten how long a watcher may be deferred.
pub(super) fn clock_ms() -> u64 {
    static ANCHOR: OnceLock<Instant> = OnceLock::new();
    ANCHOR.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// One endpoint this thread still holds watchers on but a walk did not name.
#[derive(Clone, Copy)]
struct DeferredAbsence {
    /// Incomplete passes this absence has ridden on, the current one included.
    passes: u32,
    /// When it was first suspected, in [`clock_ms`] units.
    since_ms: u64,
}

/// Bookkeeping for endpoint absences a partial walk cannot prove.
///
/// A walk that skipped an entry cannot tell a skipped endpoint from a removed
/// one. Pruning on that reading unregisters watchers of sessions that are still
/// playing, so the correction is to defer — but a deferral with no end is the
/// same bug turned slow: with one permanently flaky endpoint no later pass is
/// ever complete, and the session manager of a device that left weeks ago keeps
/// its COM registration, along with every session watcher on it and their slots
/// in the liveness ledger, for the rest of the run. So an absence is *asked
/// about* (see [`endpoint_probe`]): an answer of gone or live ends the
/// deferral on the spot, and only an endpoint that cannot be asked at all is
/// deferred, and only under a bound.
#[derive(Default)]
pub(super) struct AbsenceLedger {
    deferred: HashMap<String, DeferredAbsence>,
}

impl AbsenceLedger {
    /// Forget the endpoints that this pass named again, or that no watcher is
    /// held on any more.
    pub(super) fn sweep(&mut self, named: &HashSet<String>, watched: &HashSet<String>) {
        self.deferred
            .retain(|id, _| !named.contains(id) && watched.contains(id));
    }

    /// Whether one endpoint the walk skipped may keep its watchers this pass.
    ///
    /// `answer` is the audio service's own reading of that exact id (see
    /// [`endpoint_probe`]). An endpoint it no longer resolves, or resolves to
    /// something it does not call active, is gone and the absence is accepted at
    /// once. An endpoint it calls active keeps its watchers however often the
    /// walk fails to name it: it is handed back and walked on every one of those
    /// passes, so its expired sessions are still pruned and nothing accumulates.
    /// Only an endpoint that cannot be asked at all rides on at most
    /// [`MAX_DEFERRED_ABSENCE_PASSES`] passes or
    /// [`DEFERRED_ABSENCE_GRACE_MS`] of monotonic clock, whichever comes first —
    /// a question this thread can never get an answer to must not hold a
    /// registration for the rest of the run either.
    pub(super) fn tolerate(&mut self, id: &str, answer: EndpointAnswer, now_ms: u64) -> bool {
        if answer != EndpointAnswer::Unproven {
            self.deferred.remove(id);
            return answer == EndpointAnswer::Live;
        }
        let entry = self
            .deferred
            .entry(id.to_string())
            .or_insert(DeferredAbsence {
                passes: 0,
                since_ms: now_ms,
            });
        entry.passes += 1;
        let overdue = entry.passes >= MAX_DEFERRED_ABSENCE_PASSES
            || now_ms.saturating_sub(entry.since_ms) >= DEFERRED_ABSENCE_GRACE_MS;
        if overdue {
            self.deferred.remove(id);
            return false;
        }
        true
    }
}

/// What the audio service's own answer about one exact endpoint id means.
///
/// Only [`EndpointAnswer::Gone`] proves an absence and only
/// [`EndpointAnswer::Live`] disproves one; [`EndpointAnswer::Unproven`] keeps the
/// question open for a bounded number of passes (see [`AbsenceLedger`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum EndpointAnswer {
    /// The service names this endpoint and calls it active: the walk failed to
    /// read it, it did not go away.
    Live,
    /// The service no longer resolves this id, or resolves it to an endpoint it
    /// does not call active (unplugged, disabled, or removed from the store).
    Gone,
    /// The question could not be asked: a transient service failure says nothing
    /// about whether this endpoint is there.
    Unproven,
}

/// Whether the service's own answer about an id means that endpoint is gone.
///
/// `AUDCLNT_E_DEVICE_INVALIDATED` is what `GetDevice` returns for an id the
/// device store no longer resolves. Codes that mean "the service could not be
/// talked to just now" — a disconnected RPC channel, an out-of-memory in
/// AudioSrv, an uninitialized apartment — are deliberately *not* absence: an
/// endpoint read as gone on such a failure loses its session-manager and session
/// watchers, and because the walk is what normally re-registers them, an
/// endpoint the walk keeps failing to name would stay unwatched for the rest of
/// the run. That is the blindness this module exists to avoid.
fn lookup_denotes_absence(code: HRESULT) -> bool {
    code == AUDCLNT_E_DEVICE_INVALIDATED
}

/// Whether the service calls this endpoint an active one.
///
/// The same reading the enumeration walk filters on (`DEVICE_STATE_ACTIVE`), so
/// an endpoint the store still keeps but has unplugged or disabled answers the
/// absence question the way a vanished id does instead of riding on a bound.
fn endpoint_is_active(state: DEVICE_STATE) -> bool {
    state.0 & DEVICE_STATE_ACTIVE.0 != 0
}

/// Ask the audio service about one endpoint by its exact id.
///
/// Along with the answer it returns the endpoint itself — only for
/// [`EndpointAnswer::Live`], so a pass whose walk could not read that entry can
/// still watch a device that is demonstrably there.
pub(super) fn endpoint_probe(
    enumerator: &IMMDeviceEnumerator,
    id: &str,
) -> (EndpointAnswer, Option<DeviceRef>) {
    let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: `wide` is NUL-terminated and outlives the call; GetDevice copies
    // the id it needs before returning.
    let device = match unsafe { enumerator.GetDevice(PCWSTR(wide.as_ptr())) } {
        Ok(device) => device,
        Err(e) => {
            if lookup_denotes_absence(e.code()) {
                return (EndpointAnswer::Gone, None);
            }
            warn!("endpoint {id} could not be asked whether it is there: {e}");
            return (EndpointAnswer::Unproven, None);
        }
    };
    // SAFETY: GetState on the device this thread just obtained and owns.
    let state = match unsafe { device.GetState() } {
        Ok(state) => state,
        Err(e) => {
            // Known, but not known to be active: no evidence either way, so the
            // deferral survives under its own bound rather than being read as a
            // removal.
            warn!("endpoint {id} could not be asked its state: {e}");
            return (EndpointAnswer::Unproven, None);
        }
    };
    if endpoint_is_active(state) {
        (
            EndpointAnswer::Live,
            Some(DeviceRef {
                id: id.to_string(),
                raw: device,
            }),
        )
    } else {
        (EndpointAnswer::Gone, None)
    }
}

/// Whether a watched session reports itself gone.
///
/// Only asked of watchers a pass could not account for any other way, so the
/// cost is bounded by how many of them there are — normally none. A state that
/// cannot be read is no evidence either way and keeps the watcher.
pub(super) fn session_self_reports_gone(watched: &WatchedSession) -> bool {
    // SAFETY: GetState on a session control this thread registered and owns.
    matches!(
        unsafe { watched.control.GetState() },
        Ok(state) if state == AudioSessionStateExpired
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A device set from a list of ids.
    fn set(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|id| (*id).to_string()).collect()
    }

    /// An endpoint the audio service no longer resolves is gone on the spot.
    ///
    /// This is the case the deferral must never swallow: the watcher of a device
    /// that was pulled out keeps its COM registrations for the rest of the run,
    /// and its expired sessions keep their slots in the liveness ledger — where
    /// a PID a recycled process inherits keeps the new one drawn as sounding.
    #[test]
    fn a_device_that_answers_no_lookup_is_accepted_as_gone_at_once() {
        let mut ledger = AbsenceLedger::default();
        assert!(!ledger.tolerate("gone", EndpointAnswer::Gone, 0));
        assert!(ledger.deferred.is_empty());

        // And the next pass starts clean rather than counting towards a bound it
        // no longer needs.
        assert!(ledger.tolerate("flaky", EndpointAnswer::Unproven, 0));
        assert!(!ledger.tolerate("flaky", EndpointAnswer::Gone, 1));
        assert!(ledger.deferred.is_empty());
    }

    /// An endpoint the service still calls active is not on its way out, however
    /// often the walk fails to name it, and the bound must not say otherwise:
    /// the tolerated endpoint is handed back and walked on every one of those
    /// passes, so nothing accumulates — while a prune here would take its watchers
    /// away from a live device, and since the walk is what re-registers them, an
    /// endpoint the walk never names would never be watched again.
    #[test]
    fn a_live_endpoint_is_never_pruned_by_a_walk_that_cannot_read_it() {
        let mut ledger = AbsenceLedger::default();
        for pass in 0..3 * MAX_DEFERRED_ABSENCE_PASSES {
            assert!(
                ledger.tolerate("flaky", EndpointAnswer::Live, u64::from(pass) * 1_000),
                "pass {pass} of a walk that cannot read this entry still keeps it"
            );
        }
        // It leaves no trace behind either, so a failure that comes later starts
        // its own count instead of inheriting this one.
        assert!(ledger.deferred.is_empty());
    }

    /// The bound is for the endpoint that cannot be asked about at all: a
    /// question this thread never gets an answer to must not hold a registration
    /// for the rest of the run.
    #[test]
    fn an_endpoint_that_cannot_be_asked_is_deferred_only_a_bounded_number_of_times() {
        let mut ledger = AbsenceLedger::default();
        for pass in 1..MAX_DEFERRED_ABSENCE_PASSES {
            assert!(
                ledger.tolerate("mute", EndpointAnswer::Unproven, u64::from(pass)),
                "pass {pass} of an unanswered question still defers"
            );
        }
        assert!(
            !ledger.tolerate(
                "mute",
                EndpointAnswer::Unproven,
                u64::from(MAX_DEFERRED_ABSENCE_PASSES)
            ),
            "the bound ends the deferral when nothing else can"
        );
        assert!(ledger.deferred.is_empty());
    }

    /// The other half of the bound, for a graph that barely changes: five
    /// passes of a quiet session can be hours apart, and a deferred prune that
    /// waits that long is the leak with a longer fuse.
    #[test]
    fn the_deadline_ends_a_deferral_whatever_the_pass_count() {
        let mut ledger = AbsenceLedger::default();
        assert!(ledger.tolerate("mute", EndpointAnswer::Unproven, 0));
        assert!(ledger.tolerate("mute", EndpointAnswer::Unproven, 1_000));
        assert!(!ledger.tolerate("mute", EndpointAnswer::Unproven, DEFERRED_ABSENCE_GRACE_MS));
    }

    /// Being named again is the evidence that ends the suspicion, so a device
    /// that comes back cannot be pruned by a later pass on the strength of the
    /// passes it spent missing.
    #[test]
    fn naming_an_endpoint_again_clears_its_deferral() {
        let mut ledger = AbsenceLedger::default();
        assert!(ledger.tolerate("back", EndpointAnswer::Unproven, 0));
        assert!(ledger.tolerate("gone", EndpointAnswer::Unproven, 0));
        ledger.sweep(&set(&["back"]), &set(&["back", "gone"]));
        assert!(!ledger.deferred.contains_key("back"));
        assert!(ledger.deferred.contains_key("gone"));

        // A watcher that no longer exists stops being counted, too.
        ledger.sweep(&set(&[]), &set(&[]));
        assert!(ledger.deferred.is_empty());
    }

    /// Only the service's own "this id is no longer an endpoint" may end a
    /// deferral early. Every other failure — a disconnected RPC channel, an
    /// out-of-memory inside AudioSrv, an apartment that is not up yet — means the
    /// question could not be asked, and reading it as a removal would unregister
    /// the watchers of a device that is playing sound right now.
    #[test]
    fn a_busy_audio_service_is_not_evidence_that_an_endpoint_left() {
        use windows::Win32::Foundation::{CO_E_NOTINITIALIZED, E_OUTOFMEMORY, RPC_E_DISCONNECTED};
        use windows::Win32::Media::Audio::AUDCLNT_E_NOT_INITIALIZED;

        assert!(lookup_denotes_absence(AUDCLNT_E_DEVICE_INVALIDATED));
        for could_not_ask in [
            E_OUTOFMEMORY,
            RPC_E_DISCONNECTED,
            CO_E_NOTINITIALIZED,
            AUDCLNT_E_NOT_INITIALIZED,
        ] {
            assert!(
                !lookup_denotes_absence(could_not_ask),
                "{could_not_ask} only says the question could not be asked"
            );
        }
    }

    /// The device store keeps endpoints that are unplugged or disabled, and
    /// `GetDevice` answers for them, so the state — the same mask the walk
    /// enumerates with — is what makes a departed device a departure.
    #[test]
    fn an_endpoint_the_store_keeps_but_does_not_call_active_is_gone() {
        use windows::Win32::Media::Audio::{
            DEVICE_STATE_DISABLED, DEVICE_STATE_NOTPRESENT, DEVICE_STATE_UNPLUGGED,
        };

        assert!(endpoint_is_active(DEVICE_STATE_ACTIVE));
        for inactive in [
            DEVICE_STATE_DISABLED,
            DEVICE_STATE_NOTPRESENT,
            DEVICE_STATE_UNPLUGGED,
            DEVICE_STATE(0),
        ] {
            assert!(
                !endpoint_is_active(inactive),
                "{inactive:?} is not an endpoint the walk would have named"
            );
        }
    }
}
