//! Audio device routing.
//!
//! One channel, verified on Windows 11 24H2 (build 26100):
//!
//! 1. Per-app routing — the undocumented WinRT activatable class
//!    `Windows.Media.Internal.AudioPolicyConfig` (implemented inside
//!    AudioSes.dll), the same channel the Windows 11 Settings volume mixer
//!    uses for "app volume and device preferences":
//!    - Activation: `AudioSes.dll!DllGetActivationFactory(HSTRING(classId))`.
//!    - The factory QIs to `IAudioPolicyConfigFactory`; its IID changes across
//!      Windows builds, so it is discovered at runtime via
//!      `IInspectable::GetIids` (known values: `AB3D4648-…` Win11 21H2+,
//!      `2A59116D-…` / `32AA8E18-…` older Win10/11).
//!    - Vtable slot 25 (0-based incl. IUnknown/IInspectable) is
//!      `SetPersistedDefaultAudioEndpoint(processId: u32, flow: i32,
//!      role: i32, deviceId: HSTRING)`.
//!    - The device id must be wrapped as the endpoint's device-interface
//!      symlink: `\\?\SWD#MMDEVAPI#{<endpoint id>}#{<interface class>}`, where
//!      the class is the endpoint's own registration — `DEVINTERFACE_AUDIO_RENDER`
//!      for the playback half, `DEVINTERFACE_AUDIO_CAPTURE` for the recording
//!      half a feed is pinned through. A class the endpoint is not registered
//!      under names a symlink that does not exist, and the service answers
//!      `E_INVALIDARG`.
//!    - One call per ERole; the audio service persists the assignment per
//!      executable and applies it to sessions started afterwards (same
//!      behavior as the Settings UI). Because the audio service owns that
//!      record, it outlives this process: an app that was pointed somewhere
//!      stays pointed there until something releases it, which is why slots 25
//!      (with a null HSTRING) and 26 below matter as much as the write.
//!    - Vtable slot 26 is `GetPersistedDefaultAudioEndpoint(processId: u32,
//!      flow: i32, role: i32, deviceId: HSTRING*)`; it fails with
//!      `HRESULT_FROM_WIN32(ERROR_NOT_FOUND)` when the process carries no
//!      override, i.e. it follows the system default again.
//!    - Vtable slot 25 with a **null** HSTRING drops the override for that
//!      role, putting the process back on whatever the system default is now.
//!      The Windows volume mixer's own "Default" entry does the same thing.
//!    - Vtable slot 27 is `ClearAllPersistedApplicationDefaultEndpoints()`.
//!      Deliberately unused: it would also drop the assignments the user made
//!      by hand in the volume mixer. Releasing one process at a time covers
//!      everything this app writes.
//!
//! There is deliberately no second channel: nothing here moves the *system*
//! default device. The app's whole promise is per-program output, and a
//! system-wide write is a machine-wide change no screen of this app offers.
//!
//! One more thing rides that single entry point, because it is the only place it
//! can live: several writers can be in flight for the *same* per-program slot at
//! the same moment — a manual Apply, a sweep release, a remembered restore — and
//! whichever reached the audio service last used to win, including when it was the
//! one asked for first. The per-executable claim order below (`slot_clock`) is what
//! decides that instead: the newest ask for a slot writes, an older one is refused
//! and says so, and the refusal happens before any slot call, so a losing writer
//! never leaves a half-written assignment behind.
//!
//! This file is the module root; the code lives in the submodules below, one
//! per seam the descriptions above already draw:
//!
//! - [`policy`] — the `AudioPolicyConfig` vtable: activation, IID discovery, the
//!   slot 25/26 calls, and the device-id wrapping they are addressed with.
//!   Nothing outside it may activate the factory or call a slot.
//! - [`guard`] — who may not be routed (`routing_refusal`, called only by the
//!   door below) and who a book entry still speaks for (`entry_process_is_ours`).
//! - [`slots`] — the per-program claim order: the clock, the tickets, and the
//!   gate that refuses an older write before it touches a slot.
//! - [`pins`] — the account books: which assignments this run wrote, per data
//!   flow, and the exe-level question "is this program still routed?".
//! - [`endpoints`] — the surface the rest of the crate calls: the pin write and
//!   its single door, the release walks, and `exit_cleanup`.
//!
//! Tests stay with the code they cover, in these same files.

mod endpoints;
mod guard;
mod pins;
mod policy;
mod slots;

// The paths the rest of the crate names, re-exported so they keep resolving as
// `audio::routing::X`. The submodules themselves stay private: a second route to
// the policy factory or to a raw slot call is exactly what the guard and the
// claim order exist to make impossible, so anything that wants to write an
// endpoint comes through the door below.
pub use self::endpoints::{
    exit_cleanup, release_process_default_devices, release_process_default_devices_flow,
    set_process_default_capture_device, set_process_default_device, validate_device_id,
};
pub use self::pins::{PinnedRoutes, ReleaseOutcome};

// The rest of the surface, kept reachable under the same name for the same
// reason: nothing outside `audio` happens to spell these today (the guard is
// called only by the door, the pin types arrive through `PinnedRoutes`, callers
// use the two wrappers), and a binary crate reports a `pub use` nothing
// references as `unused_imports` — which would turn a pure split into a broken
// build and a narrower public surface at once.
//
// `set_process_default_endpoint_flow` is deliberately *not* on this list: it was
// private in the single-file layout, and only the two wrappers may call it —
// they are what pins `data_flow` to a real flow. Reaching it past them would be
// a second door the wrappers' refusal of an unnamed flow never sees.
#[allow(unused_imports)]
pub use self::endpoints::release_default_endpoints;
#[allow(unused_imports)]
pub use self::guard::routing_refusal;
#[allow(unused_imports)]
pub use self::pins::{FeedPin, PinKind, PinnedRoute};
