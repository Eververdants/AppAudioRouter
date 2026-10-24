//! The public surface: write an assignment, hand one back, and the door both
//! go through.
//!
//! [`set_process_default_endpoint_flow`] is the one entry every endpoint write
//! makes — the render half (`set_process_default_device`) and the capture half
//! (`set_process_default_capture_device`) are thin wrappers over it, and nothing
//! else in the crate activates the policy factory for a write. It is therefore
//! also the one place [`super::guard::routing_refusal`] is consulted, the one
//! place the [`super::slots`] gate stands, and the one place a partial pin is
//! rolled back rather than reported as a success.
//!
//! The release paths mirror that split: one walk clears both data flows (the
//! settings reset and app exit, via [`exit_cleanup`]), the other names which
//! half it means so that stopping a route never takes a feed's assignment away.
//! Every clear goes through slot 25 with a null HSTRING, one pid at a time, and
//! is verified by reading the assignment back.

use log::info;
use windows::core::HSTRING;

use crate::audio::AudioError;
use crate::audio::Role;

use super::guard::routing_refusal;
use super::pins::ReleaseOutcome;
use super::policy::{
    role_values, wrap_device_id_candidates, AudioPolicyConfig, E_CAPTURE, E_RENDER,
};
use super::slots::{
    claim_endpoint_slot, claim_walked_slot, flow_name, hold_slot, superseded_error, SlotClaim,
    SlotHold, SlotKey,
};

/// Validate a device id before it reaches any COM call.
///
/// Endpoint ids are non-empty, bounded in length (a few hundred chars at most),
/// and come from device enumeration in practice — but the value crosses the
/// frontend boundary, so treat it as untrusted: reject anything blank or absurd
/// long before it is baked into a symlink and handed to the audio service.
pub fn validate_device_id(device_id: &str) -> Result<(), AudioError> {
    if device_id.is_empty() {
        return Err(AudioError::Api("empty device id".to_string()));
    }
    // A real endpoint id is well under this; the bound stops runaway input from
    // being copied into stack buffers and COM calls.
    const MAX_DEVICE_ID_LEN: usize = 1024;
    if device_id.len() > MAX_DEVICE_ID_LEN {
        return Err(AudioError::Api("device id too long".to_string()));
    }
    Ok(())
}

/// The two data flows a per-app assignment can be written under. A route pins
/// the render half; a feed into this program pins the capture half. Releasing a
/// program means clearing both — one left behind keeps it fixed to an endpoint,
/// which is the whole failure the release exists to prevent.
const ALL_FLOWS: [i32; 2] = [E_RENDER, E_CAPTURE];

/// Release several processes from their per-app endpoint assignment.
///
/// One entry per PID, in no particular order. An error means the policy object
/// itself was unavailable, so nothing was released.
///
/// Deliberately the one release walk that does not stand at the write gate: it
/// answers for both data flows of every process it is handed, and its two callers
/// are the settings page's bulk reset and app exit. Refusing either of those is
/// the worse failure — exit cleanup gets no second chance at all, and the reset is
/// the documented way out of an assignment nothing else can reach — so this walk
/// clears whatever it is asked to. The reset still reads each slot back and reports
/// what it could not drop, so an answer here is never a silent success. What it
/// does not do is order itself against a concurrent write: a route that a restore
/// lands while this walk is in the air can be cleared behind its own badge, and the
/// reset's exclusion of executables with a live route is the only thing standing in
/// the way. Narrower than the gate's window, because a reset is a button the user
/// presses once rather than something that runs on every event.
pub fn release_default_endpoints(
    pids: &[u32],
    role: Role,
) -> Result<Vec<(u32, ReleaseOutcome)>, AudioError> {
    let com_owned = crate::audio::init_com()?;

    let result = (|| -> Result<Vec<(u32, ReleaseOutcome)>, AudioError> {
        let policy = AudioPolicyConfig::activate()?;
        let mut outcomes = Vec::with_capacity(pids.len());
        for &pid in pids {
            if pid == 0 {
                continue;
            }
            let mut cleared = false;
            for flow in ALL_FLOWS {
                for &r in role_values(role) {
                    if policy.clear_persisted_default(pid, flow, r).is_ok() {
                        cleared = true;
                    }
                }
            }
            if !cleared {
                outcomes.push((pid, ReleaseOutcome::Unknown));
                continue;
            }
            // Read the assignment back instead of assuming the write worked:
            // this outcome is what the user is told, and "the program follows
            // the system default again" is a promise that has to hold.
            let mut still = ReleaseOutcome::Released;
            for flow in ALL_FLOWS {
                for &r in role_values(role) {
                    match policy.get_persisted_default(pid, flow, r) {
                        Ok(Some(device_id)) => {
                            still = ReleaseOutcome::StillPinned(device_id);
                            break;
                        }
                        Ok(None) => {}
                        // The service had no answer for this role; a clear that
                        // was accepted stays accepted, so this is not a failure.
                        Err(e) => log::debug!("reading the assignment of PID {pid} failed: {e}"),
                    }
                }
                if still != ReleaseOutcome::Released {
                    break;
                }
            }
            outcomes.push((pid, still));
        }
        Ok(outcomes)
    })();

    crate::audio::uninit_com(com_owned);

    result
}

/// Hand the user's programs back on the way out, on a thread this module owns,
/// with one bounded wait covering the whole of it.
///
/// `first` runs before the endpoints: it is whatever else this run still owes
/// (the session volumes it claimed), and it is the same kind of work — a device
/// and session enumeration through the same service — so it belongs inside the
/// same deadline rather than on the WebView2 main thread, where an unresponsive
/// AudioSrv would keep the window from ever closing.
///
/// The policy factory needs an MTA thread, and the shutdown path runs on the
/// main thread (STA), so all of it moves here. The wait is bounded and never
/// joined: a shutdown must not hang on the audio service.
pub fn exit_cleanup(
    pids: Vec<u32>,
    timeout: std::time::Duration,
    first: impl FnOnce() + Send + 'static,
) -> Vec<(u32, ReleaseOutcome)> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        first();
        let result = if pids.is_empty() {
            Ok(Vec::new())
        } else {
            release_default_endpoints(&pids, Role::All)
        };
        let _ = tx.send(result);
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(outcomes)) => outcomes,
        Ok(Err(e)) => {
            log::warn!("releasing pinned endpoints failed: {e}");
            Vec::new()
        }
        Err(_) => {
            log::warn!("timed out releasing pinned endpoints");
            Vec::new()
        }
    }
}

/// Async form of [`release_default_endpoints`] for the command layer.
pub async fn release_process_default_devices(
    pids: Vec<u32>,
    role: Role,
) -> Result<Vec<(u32, ReleaseOutcome)>, AudioError> {
    tokio::task::spawn_blocking(move || release_default_endpoints(&pids, role))
        .await
        .map_err(|_| AudioError::Api("release task failed".to_string()))?
}

/// Release one data flow only: the render half a route owns, or the capture
/// half a feed owns.
///
/// The two halves are separate slots in the audio service, and a program can
/// hold both at once — routed to a device *and* recorded from by another
/// program. A release that cleared both would take the other relationship away
/// with it, so the paths that own one half say which half they mean.
pub async fn release_process_default_devices_flow(
    pids: Vec<u32>,
    role: Role,
    capture: bool,
) -> Result<Vec<(u32, ReleaseOutcome)>, AudioError> {
    tokio::task::spawn_blocking(move || release_endpoints_of_flow(&pids, role, capture))
        .await
        .map_err(|_| AudioError::Api("release task failed".to_string()))?
}

/// The blocking body of [`release_process_default_devices_flow`].
///
/// Every release here stands at the same gate a pin write does, and for the same
/// reason seen from the other side: a route that was asked for *after* this walk
/// started must not be undone by a clear that began earlier and finished later.
/// A release this run never attempted is reported as
/// [`ReleaseOutcome::Superseded`] rather than tried anyway — the slot belongs to
/// that newer writer now, and the caller has to be told nobody moved it.
fn release_endpoints_of_flow(
    pids: &[u32],
    role: Role,
    capture: bool,
) -> Result<Vec<(u32, ReleaseOutcome)>, AudioError> {
    let com_owned = crate::audio::init_com()?;
    let flow = if capture { E_CAPTURE } else { E_RENDER };
    // Stood up here, before the activation below: the ticket has to date from the
    // moment this walk decided to clear the slot, not from the moment it reaches
    // the slot, or a write that lands in between would be the older of the two.
    // One claim per slot — the walk speaks for several programs, and a newer ask
    // against one of them must not strand the others.
    let mut held: std::collections::HashMap<SlotKey, Option<SlotClaim>> =
        std::collections::HashMap::new();
    let mut claims: std::collections::HashMap<u32, Option<SlotClaim>> =
        std::collections::HashMap::new();
    for &pid in pids {
        if pid == 0 || claims.contains_key(&pid) {
            continue;
        }
        claims.insert(pid, claim_walked_slot(pid, flow, &mut held));
    }

    let result = (|| -> Result<Vec<(u32, ReleaseOutcome)>, AudioError> {
        let policy = AudioPolicyConfig::activate()?;
        let mut outcomes = Vec::with_capacity(pids.len());
        for &pid in pids {
            if pid == 0 {
                continue;
            }
            let claim = claims.get(&pid).and_then(|held| held.as_ref());
            let _slot = match hold_slot(claim) {
                SlotHold::Open(hold) => hold,
                SlotHold::Superseded(claim, newest) => {
                    // Background housekeeping losing to a newer ask is normal and
                    // says itself in the outcome; the caller that owes the user a
                    // word is the one matching on `Superseded`.
                    log::info!(
                        "the {} release of PID {pid} was superseded by a newer write \
                         (this release was asked as #{}, the slot is at #{})",
                        flow_name(flow),
                        claim.ticket,
                        newest
                    );
                    outcomes.push((pid, ReleaseOutcome::Superseded));
                    continue;
                }
            };
            let mut cleared = false;
            for &r in role_values(role) {
                if policy.clear_persisted_default(pid, flow, r).is_ok() {
                    cleared = true;
                }
            }
            if !cleared {
                outcomes.push((pid, ReleaseOutcome::Unknown));
                continue;
            }
            let mut still = ReleaseOutcome::Released;
            for &r in role_values(role) {
                match policy.get_persisted_default(pid, flow, r) {
                    Ok(Some(device_id)) => {
                        still = ReleaseOutcome::StillPinned(device_id);
                        break;
                    }
                    Ok(None) => {}
                    Err(e) => log::debug!("reading the assignment of PID {pid} failed: {e}"),
                }
            }
            outcomes.push((pid, still));
        }
        Ok(outcomes)
    })();

    crate::audio::uninit_com(com_owned);

    result
}

/// Set the default audio device for a single process (by PID).
///
/// The assignment is persisted by the audio service per executable and applies
/// to audio sessions started after this call (identical to the Windows 11
/// Settings "app volume and device preferences" toggle).
pub async fn set_process_default_device(
    device_id: &str,
    pid: u32,
    role: Role,
) -> Result<(), AudioError> {
    set_process_default_endpoint_flow(device_id, pid, role, E_RENDER).await
}

/// Pin a process's default *recording* endpoint — the capture half of the same
/// per-app assignment, and the receiving half of a feed: the target program
/// records the carrier's output through it.
pub async fn set_process_default_capture_device(
    device_id: &str,
    pid: u32,
    role: Role,
) -> Result<(), AudioError> {
    set_process_default_endpoint_flow(device_id, pid, role, E_CAPTURE).await
}

/// The pin itself, shared by both halves of the policy.
///
/// The one entry every endpoint write goes through — and now the one entry that
/// decides *whether* a write still may happen, by the per-program claim order
/// documented in the write-order section above. Nothing here is a second channel:
/// the gate performs no slot call, it only refuses this one before it starts.
pub async fn set_process_default_endpoint_flow(
    device_id: &str,
    pid: u32,
    role: Role,
    data_flow: i32,
) -> Result<(), AudioError> {
    if pid == 0 {
        return Err(AudioError::Api("invalid pid".to_string()));
    }
    if let Some(refusal) = routing_refusal(pid) {
        return Err(AudioError::Api(format!(
            "PID {pid} is {refusal}; routing it is refused"
        )));
    }
    validate_device_id(device_id)?;
    let device_id = device_id.to_string();
    // Stood up after every input check above, so a request that was never going to
    // be honoured does not spend a ticket and refuse somebody else's write, and
    // before the activation below, which is the slow part this race is measured
    // against: the ticket dates from the moment this pin was asked for.
    let claim = claim_endpoint_slot(pid, data_flow);
    // DllGetActivationFactory of AudioSes returns CLASS_E_CLASSNOTAVAILABLE on
    // an STA thread (Tauri sync commands run on the main thread, which WebView2
    // initializes as STA); run the whole activation on a dedicated MTA thread.
    tokio::task::spawn_blocking(move || {
        let com_owned = crate::audio::init_com()?;

        let result = (|| -> Result<(), AudioError> {
            let policy = AudioPolicyConfig::activate()?;
            // The gate: stand at the slot, or hand back the reason this write is no
            // longer the newest ask for it. Nothing has been written on either way,
            // which is what lets the caller's rollback skip the slot entirely.
            let _slot = match hold_slot(claim.as_ref()) {
                SlotHold::Open(hold) => hold,
                SlotHold::Superseded(claim, newest) => {
                    return Err(superseded_error(&claim, newest));
                }
            };
            let candidates: Vec<HSTRING> = wrap_device_id_candidates(&device_id, data_flow)
                .into_iter()
                .map(HSTRING::from)
                .collect();
            let mut applied: Vec<i32> = Vec::new();
            let mut last_err: Option<windows::core::HRESULT> = None;
            let wanted = role_values(role);
            for &r in wanted {
                // One role per class candidate: the first form the service
                // accepts is the endpoint's own registration, and a class it
                // rejects is left for the next candidate rather than failing
                // the whole pin over a device that registered elsewhere.
                for wrapped in &candidates {
                    let hr = policy.set_persisted_default(pid, data_flow, r, wrapped);
                    if hr.is_ok() {
                        applied.push(r);
                        break;
                    }
                    last_err = Some(hr);
                }
            }
            let what = flow_name(data_flow);
            if applied.len() != wanted.len() {
                // Half a pin is not a route. Reported as a success it would
                // leave the roles that failed on whatever the program played
                // before — the board says one device, the sound comes out of
                // another — and as a plain failure it would leave the roles that
                // landed with nothing on our books pointing at them, because a
                // caller only books a pin it was told it got. So drop the roles
                // this call wrote, then report the refusal.
                for &r in &applied {
                    let back = policy.clear_persisted_default(pid, data_flow, r);
                    if back.is_err() {
                        let code = format!("0x{:08X}", back.0);
                        log::warn!(
                            "could not drop the partial {what} pin of PID {pid} (role {r}): {code}"
                        );
                    }
                }
                // `applied` coming up short means some role failed every
                // candidate, so a code was recorded for it.
                let hr = last_err.unwrap();
                return Err(AudioError::Api(format!(
                    "SetPersistedDefaultAudioEndpoint failed: 0x{:08X} (roles applied: {} of {})",
                    hr.0,
                    applied.len(),
                    wanted.len()
                )));
            }
            info!("pinned PID {pid} {what} endpoint to device {device_id}");
            Ok(())
        })();

        crate::audio::uninit_com(com_owned);

        result
    })
    .await
    .map_err(|_| AudioError::Api("routing task failed".to_string()))?
}

// ---------------------------------------------------------------------------
// System-wide default: deliberately not implemented
// ---------------------------------------------------------------------------
//
// Nothing on this side moves the *system* default endpoint. The app's promise is
// per-program output, and the machine-wide write (`CPolicyConfigClient` /
// `IPolicyConfig::SetDefaultEndpoint`, vtable slot 13) had no screen, no caller
// and no undo: a command that could switch every program that follows the
// default, behind the back of the user's own picker. It is removed rather than
// left usable; if a system-wide switch is ever wanted, it has to arrive with the
// UI, the log line and the undo that make it a deliberate act.

#[cfg(test)]
mod tests {
    use super::*;

    /// Every device id crosses the frontend boundary, and only some of them ever
    /// reach a COM call: the delay and share of a device are keys of a config
    /// file this app reads back for as long as it lives. Blank and absurd values
    /// are refused at the same bound for both.
    #[test]
    fn a_device_key_is_refused_when_blank_or_absurd() {
        assert!(validate_device_id("").is_err());
        assert!(validate_device_id(&"x".repeat(1025)).is_err());
        assert!(
            validate_device_id("{0.0.0.00000000}.{1c1b1e0d-e0e3-41de-915c-5db74e4b693a}").is_ok()
        );
    }
}
