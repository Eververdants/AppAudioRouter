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

use log::info;
use windows::core::{GUID, HSTRING};

use crate::audio::AudioError;
use crate::audio::Role;

const AUDIO_POLICY_CONFIG_CLASS: &str = "Windows.Media.Internal.AudioPolicyConfig";

// Known IAudioPolicyConfigFactory IIDs, preferred over the raw GetIids
// fallback when present.
const KNOWN_FACTORY_IIDS: [GUID; 3] = [
    GUID::from_u128(0xab3d4648_e242_459f_b02f_541c70306324), // Win11 21H2+
    GUID::from_u128(0x2a59116d_6c4f_45e0_a74f_707e3fef9258), // downlevel
    GUID::from_u128(0x32aa8e18_6496_4e24_9f94_b800e7eccc45), // older Win10
];

// Device-interface classes the endpoint's symlink is registered under, appended
// after the endpoint id. The class must match the endpoint's data flow: a
// capture endpoint has no `DEVINTERFACE_AUDIO_RENDER` symlink to its name, and
// a wrapped id pointing at an interface that does not exist is what the audio
// service answers with `E_INVALIDARG` (0x80070057).
const RENDER_DEVICE_INTERFACE: &str = "#{e6327cad-dcec-4949-ae8a-991e976a79d2}"; // DEVINTERFACE_AUDIO_RENDER
const CAPTURE_DEVICE_INTERFACE: &str = "#{2eef81be-33fa-4800-9670-1cd474972c3f}"; // DEVINTERFACE_AUDIO_CAPTURE
/// The class some render endpoints — Bluetooth hands-free ones, seen on a
/// Windows 11 24H2 machine — are registered under *instead of* the render
/// class. Tried after it, so such an endpoint is still pinnable.
const ALT_RENDER_DEVICE_INTERFACE: &str = "#{934bd8a8-a593-445a-9e1d-a915ffaca629}";
const MMDEVAPI_TOKEN: &str = "\\\\?\\SWD#MMDEVAPI#";

// EDataFlow
const E_RENDER: i32 = 0;
// The capture half of the same policy API: a program's default *recording*
// endpoint is pinned through the identical slot, addressed by data flow.
const E_CAPTURE: i32 = 1;

// ERole values used by the policy API.
const ROLE_CONSOLE: i32 = 0;
const ROLE_MULTIMEDIA: i32 = 1;
const ROLE_COMMUNICATIONS: i32 = 2;

// Vtable slots of IAudioPolicyConfigFactory (0-based incl. IUnknown/IInspectable).
const SLOT_SET_PERSISTED_DEFAULT: usize = 25;
const SLOT_GET_PERSISTED_DEFAULT: usize = 26;

/// `HRESULT_FROM_WIN32(ERROR_NOT_FOUND)`, the audio service's answer when a
/// process has no persisted endpoint at all.
const HR_ERROR_NOT_FOUND: i32 = 0x80070490u32 as i32;

type SetPersistedDefaultAudioEndpointFn = unsafe extern "system" fn(
    this: *mut core::ffi::c_void,
    process_id: u32,
    data_flow: i32,
    role: i32,
    device_id: isize, // HSTRING
) -> windows::core::HRESULT;

/// Extract the raw HSTRING handle from an `HSTRING` (it is a transparent
/// wrapper around `*mut HSTRING__`).
fn hstring_handle(h: &HSTRING) -> isize {
    // SAFETY: HSTRING is #[repr(transparent)] over a raw handle pointer.
    unsafe { core::ptr::read(h as *const HSTRING as *const isize) }
}

// ---------------------------------------------------------------------------
// Per-app routing
// ---------------------------------------------------------------------------

/// Whether `pid` still names the process this book entry was written for.
///
/// With a captured witness this is the exact question: `process_is_running`
/// compares the creation time, so a pid the kernel has since handed to another
/// program answers `no`.
///
/// Without one it is not. `creation_time` of 0 means the process could not be
/// opened when the entry was written — most often because it had already exited
/// a moment after the write that got it routed — and `process_is_running` then
/// judges only the exit code: *any* live process holding that pid would be read
/// as ours, which is exactly the recycling this witness exists to prevent. Left
/// as the answer, a stranger would speak for the entry: its executable hidden
/// from the settings reset, its feeds suspended for good, its stale bookkeeping
/// dropped before the assignment is handed back.
///
/// So the entry falls back to the next best witness, the executable name. The
/// assignment the entry describes is stored per executable anyway, so a process
/// of the same program still holds it and a process of another one does not; an
/// entry that cannot even say whose it is has no witness at all and answers
/// `no`, because the paths that ask all have a conservative reading of `no`.
fn entry_process_is_ours(pid: u32, creation_time: u64, exe_name: &str) -> bool {
    if creation_time != 0 {
        return super::process_is_running(pid, creation_time);
    }
    if !super::process_is_running(pid, 0) {
        return false;
    }
    if exe_name.is_empty() {
        return false;
    }
    process_name_for_guard(pid).is_some_and(|name| name.eq_ignore_ascii_case(exe_name))
}

/// Release one reference to a raw COM object through its own vtable.
///
/// # Safety
/// `obj` must point at a live COM object, and this call must own exactly one
/// reference to it — the object is invalid once that reference was its last.
unsafe fn release_com(obj: *mut core::ffi::c_void) {
    // SAFETY: a COM object starts with a pointer to its vtable, whose slot 2 is
    // IUnknown::Release; the caller owns the reference being dropped.
    let vtable = *(obj as *const usize);
    let release: unsafe extern "system" fn(*mut core::ffi::c_void) -> u32 =
        core::mem::transmute(*((vtable + 2 * 8) as *const usize));
    release(obj);
}

/// Handle to the activated `IAudioPolicyConfigFactory` interface.
struct AudioPolicyConfig {
    obj: *mut core::ffi::c_void,
    vtable: usize,
}

/// Handle to AudioSes.dll, loaded once for the life of the process.
///
/// Every route and every release used to raise the module's reference count
/// through `LoadLibraryW` and never give it back — harmless on an afternoon,
/// a slow leak across a session of many routes. `FreeLibraryW` is still not
/// called: the DLL stays mapped from the first route to process exit, which
/// is exactly what the audio service needs it for anyway.
fn audio_ses_module() -> Result<isize, AudioError> {
    use std::sync::OnceLock;
    static MODULE: OnceLock<isize> = OnceLock::new();

    if let Some(module) = MODULE.get() {
        return Ok(*module);
    }
    use std::os::windows::ffi::OsStrExt;
    extern "system" {
        fn LoadLibraryW(name: *const u16) -> isize;
    }
    // SAFETY: loading a system DLL.
    let module = unsafe {
        let name: Vec<u16> = std::ffi::OsStr::new("AudioSes.dll\0")
            .encode_wide()
            .collect();
        LoadLibraryW(name.as_ptr())
    };
    if module == 0 {
        return Err(AudioError::Api(
            "LoadLibraryW(AudioSes.dll) failed".to_string(),
        ));
    }
    // Two threads racing the load both hold valid handles to the same DLL;
    // whichever write lands, the value is good.
    let _ = MODULE.set(module);
    Ok(MODULE.get().copied().unwrap_or(module))
}

impl AudioPolicyConfig {
    /// Activate the factory and QI to the build-specific interface.
    fn activate() -> Result<Self, AudioError> {
        extern "system" {
            fn GetProcAddress(module: isize, name: *const u8) -> isize;
        }

        // SAFETY: export name is a valid NUL-terminated literal.
        let proc_addr = unsafe {
            GetProcAddress(
                audio_ses_module()?,
                c"DllGetActivationFactory".as_ptr() as *const u8,
            )
        };
        if proc_addr == 0 {
            return Err(AudioError::Api(
                "AudioSes.dll does not export DllGetActivationFactory".to_string(),
            ));
        }
        type DllGetActivationFactoryFn =
            unsafe extern "system" fn(isize, *mut *mut core::ffi::c_void) -> windows::core::HRESULT;
        // SAFETY: WinRT activation contract signature.
        let dll_get_factory: DllGetActivationFactoryFn = unsafe { core::mem::transmute(proc_addr) };

        let class_hstring = HSTRING::from(AUDIO_POLICY_CONFIG_CLASS);
        let mut raw: *mut core::ffi::c_void = std::ptr::null_mut();
        // SAFETY: valid HSTRING and out pointer; the reference it hands back is
        // released below, whichever way the discovery and the QI go.
        let hr = unsafe { dll_get_factory(hstring_handle(&class_hstring), &mut raw) };
        if hr.is_err() || raw.is_null() {
            return Err(AudioError::Api(format!(
                "DllGetActivationFactory failed: 0x{:08X}",
                hr.0
            )));
        }

        let vtable = unsafe { *(raw as *const usize) };
        let activated = Self::discover_interface_iid(raw, vtable)
            .and_then(|target_iid| Self::query_interface(raw, &target_iid));
        // The interface used from here on carries the reference the QI took, so
        // the factory's own has to go: a long-lived background app activates
        // this on every route and every release, and each one left behind here
        // is an object that never dies.
        // SAFETY: `raw` is the live factory this call owns one reference to.
        unsafe { release_com(raw) };
        activated
    }

    /// Discover the build-specific factory IID via `IInspectable::GetIids`,
    /// preferring known IIDs; falls back to the last discovered IID.
    fn discover_interface_iid(
        raw: *mut core::ffi::c_void,
        vtable: usize,
    ) -> Result<GUID, AudioError> {
        type GetIidsFn = unsafe extern "system" fn(
            this: *mut core::ffi::c_void,
            iid_count: *mut u32,
            iids: *mut *mut GUID,
        ) -> windows::core::HRESULT;

        // SAFETY: GetIids is IInspectable slot 3.
        let get_iids: GetIidsFn =
            unsafe { core::mem::transmute(*((vtable + 3 * 8) as *const usize)) };
        let mut count: u32 = 0;
        let mut iids: *mut GUID = std::ptr::null_mut();
        // SAFETY: valid out params; returned array freed below.
        let hr = unsafe { get_iids(raw, &mut count, &mut iids) };
        let mut discovered = Vec::new();
        if hr.is_ok() && !iids.is_null() && count > 0 {
            // SAFETY: `count` GUIDs returned by GetIids.
            let slice = unsafe { std::slice::from_raw_parts(iids, count as usize) };
            discovered.extend_from_slice(slice);
        }
        if !iids.is_null() {
            // SAFETY: frees the GetIids allocation.
            unsafe {
                windows::Win32::System::Com::CoTaskMemFree(Some(iids as *const core::ffi::c_void))
            };
        }

        for known in KNOWN_FACTORY_IIDS {
            if discovered.contains(&known) {
                return Ok(known);
            }
        }
        if let Some(last) = discovered.last() {
            return Ok(*last);
        }
        Err(AudioError::Api(
            "IAudioPolicyConfigFactory IID not discovered (GetIids failed)".to_string(),
        ))
    }

    /// QueryInterface the activation factory for `iid`.
    fn query_interface(raw: *mut core::ffi::c_void, iid: &GUID) -> Result<Self, AudioError> {
        type QIFn = unsafe extern "system" fn(
            this: *mut core::ffi::c_void,
            iid: *const GUID,
            out: *mut *mut core::ffi::c_void,
        ) -> windows::core::HRESULT;

        let vtable = unsafe { *(raw as *const usize) };
        // SAFETY: QI is IUnknown slot 0.
        let qi: QIFn = unsafe { core::mem::transmute(*(vtable as *const usize)) };
        let mut obj: *mut core::ffi::c_void = std::ptr::null_mut();
        // SAFETY: valid GUID and out pointer.
        let hr = unsafe { qi(raw, iid, &mut obj) };
        if hr.is_err() || obj.is_null() {
            return Err(AudioError::Api(format!(
                "QueryInterface(IAudioPolicyConfigFactory {:?}) failed: 0x{:08X}",
                iid, hr.0
            )));
        }
        let vtable = unsafe { *(obj as *const usize) };
        Ok(Self { obj, vtable })
    }

    /// Set the persisted default endpoint of a process for one role.
    ///
    /// `data_flow` picks which half of the policy is addressed: `E_RENDER` is
    /// where the program plays, `E_CAPTURE` is where it records — a feed into
    /// another program is delivered by pointing the *target* at the carrier's
    /// capture side through this same slot.
    fn set_persisted_default(
        &self,
        process_id: u32,
        data_flow: i32,
        role: i32,
        device_hstring: &HSTRING,
    ) -> windows::core::HRESULT {
        // SAFETY: slot 25 signature documented at module level; all arguments
        // outlive the call.
        let f: SetPersistedDefaultAudioEndpointFn = unsafe {
            core::mem::transmute(*((self.vtable + SLOT_SET_PERSISTED_DEFAULT * 8) as *const usize))
        };
        // SAFETY: COM call on a live object.
        unsafe {
            f(
                self.obj,
                process_id,
                data_flow,
                role,
                hstring_handle(device_hstring),
            )
        }
    }

    /// Drop a process's persisted endpoint for one role and data flow.
    ///
    /// A null HSTRING is the service's "no assignment" value: after this call
    /// the process follows whatever the system default is, now and later.
    fn clear_persisted_default(
        &self,
        process_id: u32,
        data_flow: i32,
        role: i32,
    ) -> windows::core::HRESULT {
        let f: SetPersistedDefaultAudioEndpointFn = unsafe {
            core::mem::transmute(*((self.vtable + SLOT_SET_PERSISTED_DEFAULT * 8) as *const usize))
        };
        // SAFETY: COM call on a live object; a null HSTRING is a documented
        // input for this parameter and outlives nothing.
        unsafe { f(self.obj, process_id, data_flow, role, 0) }
    }

    /// Read a process's persisted endpoint for one role and data flow.
    ///
    /// `Ok(None)` means the process carries no assignment and follows the
    /// system default; `Ok(Some(id))` is the endpoint id it is pinned to.
    fn get_persisted_default(
        &self,
        process_id: u32,
        data_flow: i32,
        role: i32,
    ) -> Result<Option<String>, AudioError> {
        type GetPersistedDefaultAudioEndpointFn =
            unsafe extern "system" fn(
                this: *mut core::ffi::c_void,
                process_id: u32,
                data_flow: i32,
                role: i32,
                device_id: *mut HSTRING, // HSTRING out
            ) -> windows::core::HRESULT;

        let f: GetPersistedDefaultAudioEndpointFn = unsafe {
            core::mem::transmute(*((self.vtable + SLOT_GET_PERSISTED_DEFAULT * 8) as *const usize))
        };
        // An empty HSTRING is both a valid out parameter and what the service
        // leaves in it when the process carries no assignment; dropping it hands
        // the returned string back.
        let mut device_id = HSTRING::new();
        // SAFETY: COM call on a live object; the out HSTRING is owned here.
        let hr = unsafe { f(self.obj, process_id, data_flow, role, &mut device_id) };
        if hr.0 == HR_ERROR_NOT_FOUND {
            return Ok(None);
        }
        if hr.is_err() {
            return Err(AudioError::Api(format!(
                "GetPersistedDefaultAudioEndpoint failed: 0x{:08X}",
                hr.0
            )));
        }
        if device_id.is_empty() {
            return Ok(None);
        }
        let value = device_id.to_string_lossy();
        if value.is_empty() {
            return Ok(None);
        }
        Ok(Some(unwrap_device_id(&value)))
    }
}

impl Drop for AudioPolicyConfig {
    fn drop(&mut self) {
        // SAFETY: balances the QI reference taken in query_interface; `obj` is
        // live and this is the last reference this wrapper holds.
        unsafe { release_com(self.obj) };
    }
}

/// Wrap a raw endpoint id (`{0.0.0.00000000}.{guid}`) into the device-interface
/// symlink forms expected by `SetPersistedDefaultAudioEndpoint`, one per class
/// that flow's endpoints may be registered under — most preferred first.
///
/// A wrap per data flow, because the interface class is part of the endpoint's
/// registration: the capture side of a feed pair is only reachable through
/// `DEVINTERFACE_AUDIO_CAPTURE`, and wrapping it in the render class names a
/// symlink that does not exist (`E_INVALIDARG` on every role).
fn wrap_device_id_candidates(device_id: &str, data_flow: i32) -> Vec<String> {
    if device_id.starts_with(MMDEVAPI_TOKEN) {
        return vec![device_id.to_string()];
    }
    interface_suffixes(data_flow)
        .iter()
        .map(|suffix| format!("{MMDEVAPI_TOKEN}{device_id}{suffix}"))
        .collect()
}

/// The interface-class suffixes worth trying for one data flow, in order.
fn interface_suffixes(data_flow: i32) -> &'static [&'static str] {
    if data_flow == E_CAPTURE {
        &[CAPTURE_DEVICE_INTERFACE]
    } else {
        &[RENDER_DEVICE_INTERFACE, ALT_RENDER_DEVICE_INTERFACE]
    }
}

/// Turn a device-interface symlink back into the plain endpoint id the rest of
/// the app (and the Windows volume mixer) uses.
fn unwrap_device_id(device_id: &str) -> String {
    let trimmed = device_id.strip_prefix(MMDEVAPI_TOKEN).unwrap_or(device_id);
    for suffix in [
        RENDER_DEVICE_INTERFACE,
        CAPTURE_DEVICE_INTERFACE,
        ALT_RENDER_DEVICE_INTERFACE,
    ] {
        if let Some(stripped) = trimmed.strip_suffix(suffix) {
            return stripped.to_string();
        }
    }
    trimmed.to_string()
}

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

fn role_values(role: Role) -> &'static [i32] {
    match role {
        Role::All => &[ROLE_CONSOLE, ROLE_MULTIMEDIA, ROLE_COMMUNICATIONS],
    }
}

// ---------------------------------------------------------------------------
// Safety rails
// ---------------------------------------------------------------------------

/// Executables whose audio belongs to Windows itself.
///
/// Moving one of these is refused rather than half-applied: the audio service
/// is a system-critical process, and a wrong endpoint on it is the kind of
/// mistake that leaves a machine without sound.
const PROTECTED_EXES: [&str; 9] = [
    "system",
    "registry",
    "smss.exe",
    "csrss.exe",
    "wininit.exe",
    "services.exe",
    "lsass.exe",
    "winlogon.exe",
    "audiodg.exe",
];

/// Why routing this PID must be refused, in the words the log and the frontend
/// will see; `None` means it may be routed.
///
/// PID 0 (the system-sounds session) and PID 4 (`System`) are protected by
/// identity, everything else by executable name.
///
/// A name that cannot be read at all is refused too, and that is the part worth
/// reading twice. The processes this list exists for are the ones an ordinary
/// user cannot open — `csrss.exe`, `lsass.exe`, `audiodg.exe` are protected
/// against exactly that — so an unreadable name is where they hide, and
/// guessing "not on the list" re-points every session a program holds, which is
/// the one mistake here that would take the whole machine's audio with it. The
/// price is that a program running more elevated than this app cannot be routed;
/// the message says which of the two happened instead of accusing it.
pub fn routing_refusal(pid: u32) -> Option<&'static str> {
    if pid == 0 || pid == 4 {
        return Some("a system-critical process");
    }
    match process_name_for_guard(pid) {
        Some(name) => PROTECTED_EXES
            .iter()
            .any(|protected| name.eq_ignore_ascii_case(protected))
            .then_some("a system-critical process"),
        None => Some("a process this app cannot identify"),
    }
}

/// The executable name the guard compares against `PROTECTED_EXES`.
///
/// `QueryFullProcessImageNameW` first: it needs less of a right than the
/// image-name API and hands back a real path. The `A` form is the fallback, not
/// the other way round — its fixed 260-byte buffer reports nothing for a longer
/// path, and "nothing" was the answer that let a protected process through.
fn process_name_for_guard(pid: u32) -> Option<String> {
    crate::audio::process_meta::process_image(pid)
        .map(|(_, name)| name)
        .or_else(|| crate::audio::sessions::get_process_exe_name(pid))
}

// ---------------------------------------------------------------------------
// Write order
// ---------------------------------------------------------------------------

/// One program's endpoint slot, addressed the way the audio service addresses
/// it: by executable, and by which of the two data flows the write means.
///
/// The two halves carry one counter each because they *are* two slots — a
/// program can be routed to a device and receive a feed at the same time, and a
/// newer ask on the capture half has no business refusing a write to the render
/// half. Same reasoning that gives `PinnedRoutes` two feed books beside the
/// route book, and it is why the release paths name the flow they mean.
type SlotKey = (String, i32);

/// The clock, and the lock that keeps a gated write alone with its slot.
type SlotClock = std::sync::Mutex<std::collections::HashMap<SlotKey, u64>>;

/// A hold on the clock taken at the gate.
type SlotHoldGuard<'a> = std::sync::MutexGuard<'a, std::collections::HashMap<SlotKey, u64>>;

/// Where one write stands in the order of its slot.
///
/// Frontend-side queueing was the other shape on the table and is deliberately
/// not this one: a queue would make Apply wait behind whatever the sweep had
/// already lined up, and the ticket a page hands out restarts with the page.
/// The clock is therefore Rust's own, and nothing about it crosses the wire.
#[derive(Clone)]
struct SlotClaim {
    key: SlotKey,
    ticket: u64,
}

/// The clock every writer of a slot shares.
///
/// One mutex does both jobs — handing out tickets and gating the write — on
/// purpose: with a single lock, a ticket can never be handed out while another
/// writer is inside the slot, so a writer that passes the gate is certain to
/// land, and a writer that loses it has not touched the slot at all. That is the
/// whole window: the reader of an older ticket used to be free to arrive last.
///
/// **Leaf lock.** Nothing in this crate may take it while holding a
/// `PinnedRoutes` book lock, and nothing may take a book lock while holding it.
/// The books are written by callers once the slot call has returned, and no
/// system call happens under either (`exe_routed_elsewhere` spells out the same
/// rule for the books). Only the slot calls themselves run under this lock —
/// the policy activation, which is the slow part, stays outside of it.
fn slot_clock() -> &'static SlotClock {
    static CLOCK: std::sync::OnceLock<SlotClock> = std::sync::OnceLock::new();
    CLOCK.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Issue the next ticket for one slot. Kept apart from the lock so the numbering
/// can be tested.
fn ticket_for(clock: &mut std::collections::HashMap<SlotKey, u64>, key: &SlotKey) -> u64 {
    let issued = clock.entry(key.clone()).or_insert(0);
    *issued += 1;
    *issued
}

/// Whether a claim still stands at the front of its own slot.
///
/// The rule, so it can be said out loud rather than inferred from an `if`: the
/// newest claim wins, **equal counts as newest**, and an older one loses. A claim
/// nothing else has touched its slot since is the writer that has to be allowed
/// through, or the first route on a quiet machine would refuse itself. A claim
/// *ahead* of the clock can only mean the clock forgot this slot, which is the
/// same situation, so it goes through too. Nothing else is consulted: a stamp
/// from another executable, or from the other half of the same program, says
/// nothing about this slot.
fn claim_is_newest(clock: &std::collections::HashMap<SlotKey, u64>, claim: &SlotClaim) -> bool {
    clock
        .get(&claim.key)
        .map(|issued| *issued <= claim.ticket)
        // A slot nobody has claimed since this write did — nothing to lose to.
        .unwrap_or(true)
}

/// Which slot the write path addresses: the program `pid` runs, and the half of
/// its assignment the write means. `None` when the executable cannot be named.
fn slot_key_for(pid: u32, data_flow: i32) -> Option<SlotKey> {
    let exe_name = process_name_for_guard(pid)?;
    Some((exe_name.to_ascii_lowercase(), data_flow))
}

/// Take the next ticket for a slot the caller has already resolved.
fn claim_slot(key: &SlotKey) -> SlotClaim {
    let mut clock = slot_clock().lock().unwrap_or_else(|e| e.into_inner());
    let ticket = ticket_for(&mut clock, key);
    SlotClaim {
        key: key.clone(),
        ticket,
    }
}

/// Take this write's place in the order of the program `pid` runs, on the
/// `data_flow` half of its slot.
///
/// `None` when the executable cannot be named, and that hole is on purpose: the
/// writers that reach this with an unnameable process are releases of a program
/// that has already gone away, and refusing to hand an assignment back is the
/// exact failure 2.1.1 exists to close. A *write* never takes it — an unreadable
/// name is what `routing_refusal` refuses the route over, before this is asked.
fn claim_endpoint_slot(pid: u32, data_flow: i32) -> Option<SlotClaim> {
    slot_key_for(pid, data_flow).map(|key| claim_slot(&key))
}

/// The claim for `pid`'s slot, taken from `held` when this walk already took one.
///
/// Two processes of one program address the same slot, and one release walk speaks
/// for that slot once: handing the second pid a second ticket would make the *first*
/// pid's release the older claim and refuse it, so a walk would supersede itself and
/// leave one of the two programs pinned while reporting both handed back.
fn claim_walked_slot(
    pid: u32,
    data_flow: i32,
    held: &mut std::collections::HashMap<SlotKey, Option<SlotClaim>>,
) -> Option<SlotClaim> {
    let key = slot_key_for(pid, data_flow)?;
    if let Some(existing) = held.get(&key) {
        return existing.clone();
    }
    let claim = Some(claim_slot(&key));
    held.insert(key, claim.clone());
    claim
}

/// A write's hold on its slot, or the reason it may not have the slot.
enum SlotHold<'a> {
    /// This write is the newest ask its slot has seen. The guard, when there is
    /// one, keeps every other writer's claim and gate out until this write's slot
    /// calls are done; `None` holds nothing, for a slot this side could not name.
    Open(Option<SlotHoldGuard<'a>>),
    /// A newer ask claimed the slot while this write was activating the policy
    /// object, so writing now would land on top of something asked for afterwards.
    Superseded(SlotClaim, u64),
}

/// Stand at the gate: refuse the write if a newer claim took its slot in the
/// meantime, otherwise keep the slot to this write until the guard is dropped.
///
/// The check and the hold are the same lock acquisition, which is what makes the
/// window close: between the read of the clock and the slot call there is no gap
/// another writer can claim through.
fn hold_slot(claim: Option<&SlotClaim>) -> SlotHold<'static> {
    let Some(claim) = claim else {
        return SlotHold::Open(None);
    };
    let hold = slot_clock().lock().unwrap_or_else(|e| e.into_inner());
    if claim_is_newest(&hold, claim) {
        return SlotHold::Open(Some(hold));
    }
    let newest = hold.get(&claim.key).copied().unwrap_or(claim.ticket);
    drop(hold);
    SlotHold::Superseded(claim.clone(), newest)
}

/// The flow's own word for the log and for the refusal's wording.
fn flow_name(data_flow: i32) -> &'static str {
    if data_flow == E_CAPTURE {
        "capture"
    } else {
        "render"
    }
}

/// The words a superseded write answers with.
///
/// Distinguishable because the two sides have to tell it apart from a plain
/// failure: a write the service refused leaves nothing in charge of the slot,
/// while a write refused here leaves a *newer* writer in charge, and the caller
/// must not "fall back" over that writer's choice. The user reads this string in
/// one Toast card, so it names the program and says what beat it.
fn superseded_error(claim: &SlotClaim, newest: u64) -> AudioError {
    AudioError::Api(format!(
        "the {} assignment for {} was superseded by a newer one (this write was asked as #{}, \
         the slot is at #{})",
        flow_name(claim.key.1),
        claim.key.0,
        claim.ticket,
        newest
    ))
}

// ---------------------------------------------------------------------------
// Releasing an assignment again
// ---------------------------------------------------------------------------

/// What a release attempt left behind for one process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReleaseOutcome {
    /// The process carries no assignment and follows the system default again.
    Released,
    /// The assignment is still there and points at this endpoint id.
    StillPinned(String),
    /// The audio service would not answer for this process.
    Unknown,
    /// This run never asked the service at all: a newer write claimed the
    /// program's slot while this release was still setting itself up, so the
    /// assignment the release was aimed at belongs to that writer now.
    ///
    /// Not a refusal to hand the assignment back and not a success either —
    /// nothing was cleared, and nothing may be written over the slot in apology.
    /// A caller that read this as "not confirmed clear" and fell back to pointing
    /// the program at the default would take the newer writer's route away, which
    /// is the exact failure the claim order exists to prevent; a caller that read
    /// it as "released" would forget a pin that is still standing.
    Superseded,
}

/// Why this run is holding an endpoint assignment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinKind {
    /// A live route: the program is pointed at the devices the user chose.
    Route,
    /// The program's route was stopped, but Windows would not let the assignment
    /// go, so it was pointed at the current default device instead. Nothing is
    /// routing it — the entry is only here so that assignment stays ours to
    /// release later.
    ReturnedToDefault,
    /// Neither the release nor the fallback write landed, so this run no longer
    /// knows where the program is pointed and cannot move it. The entry stays
    /// for the same reason `ReturnedToDefault` does — the assignment is still
    /// ours — but it must not be read as a route, or nothing but an app restart
    /// could ever clear it.
    Abandoned,
}

/// A process this run has pointed at an explicit endpoint.
pub struct PinnedRoute {
    /// Executable name, so a relaunch of the same program can be found again.
    pub exe_name: String,
    /// Endpoint the process was pointed at.
    pub device_id: String,
    /// Whether a route of ours — as opposed to a handed-back program — owns it.
    pub kind: PinKind,
    /// The process's creation time when the entry was written — the same
    /// pid-recycling witness a [`FeedPin`] carries; 0 when it could not be read.
    pub creation_time: u64,
}

/// One feed endpoint this run pinned. Which of the two halves it is comes from
/// the book it lives in, not from a field: one pid can hold both at once, when
/// it receives one program's sound and feeds another's.
#[derive(Debug, Clone)]
pub struct FeedPin {
    /// Executable the pin speaks for, so a removal can find the memory rule.
    pub exe_name: String,
    /// The process's creation time when this pin was written. The pid is the
    /// only handle the release paths get, and the kernel hands pids to new
    /// processes — this is what tells the sweep that a pin's pid still names
    /// the process the pin speaks for.
    pub creation_time: u64,
}

impl FeedPin {
    fn new(pid: u32, exe_name: &str) -> Self {
        Self {
            exe_name: exe_name.to_string(),
            creation_time: super::process_creation_time(pid).unwrap_or(0),
        }
    }
}

/// The endpoint assignments this run wrote.
///
/// Windows keeps a per-app endpoint assignment after the program that wrote it
/// is gone, and that assignment outranks any later change of the system default
/// device — an app left pinned stops following the user's device switches, which
/// is exactly the complaint 2.1.1 answers. So every assignment this app writes
/// has to be released again: when its route stops, when the app quits, and when
/// the routed program is relaunched after having exited while pinned.
///
/// Tracking them is also what keeps the release honest: an assignment the user
/// made by hand in the volume mixer is none of our business and must survive.
#[derive(Default)]
pub struct PinnedRoutes {
    inner: std::sync::Mutex<std::collections::HashMap<u32, PinnedRoute>>,
    /// Feed endpoints, tracked apart from the route assignments because they
    /// own the *other* data flow: a program can be routed to a device and feed
    /// another program at the same time, and releasing one must not touch the
    /// other. The two flows get one book each for the same reason: the audio
    /// service addresses a program by pid on both, so a chain (`A` into `B`,
    /// `B` into `C`) writes `B`'s capture half and its render half, and one
    /// keyed by pid alone would lose whichever was pinned second. A lost pin is
    /// a write nothing can reach again — the endpoint stays set after the UI
    /// says the feed was removed.
    feed_sources: std::sync::Mutex<std::collections::HashMap<u32, FeedPin>>,
    feed_targets: std::sync::Mutex<std::collections::HashMap<u32, FeedPin>>,
}

impl PinnedRoutes {
    /// An empty book; entries arrive as assignments are written.
    pub fn new() -> Self {
        Self::default()
    }

    /// Record that this app pointed `pid` at `device_id` for a live route.
    pub fn mark(&self, pid: u32, exe_name: &str, device_id: &str) {
        self.insert(pid, exe_name, device_id, PinKind::Route);
    }

    /// Record that `pid` was handed back to the current default device, because
    /// Windows would not release the assignment its route left behind.
    pub fn mark_returned(&self, pid: u32, exe_name: &str, device_id: &str) {
        self.insert(pid, exe_name, device_id, PinKind::ReturnedToDefault);
    }

    /// Downgrade `pid`'s entry: this run has lost control of that assignment —
    /// the release was refused and the fallback write failed after it — so the
    /// program sits on some endpoint and nothing here can move it any more.
    ///
    /// The entry stays, because that assignment is still ours and app exit has
    /// to walk it, but its kind must come off `Route`. Left standing it hides
    /// the program from the settings page's reset, which excludes every
    /// executable with a live route, *and* from the stale sweep, which only
    /// releases pids that have gone away — while the board shows no route for
    /// the user to stop. Restarting this app would be the only way out, which is
    /// the dead end 2.1.1 exists to close.
    pub fn mark_abandoned(&self, pid: u32) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(route) = inner.get_mut(&pid) {
            route.kind = PinKind::Abandoned;
        }
    }

    fn insert(&self, pid: u32, exe_name: &str, device_id: &str, kind: PinKind) {
        let creation_time = super::process_creation_time(pid).unwrap_or(0);
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.insert(
            pid,
            PinnedRoute {
                exe_name: exe_name.to_string(),
                device_id: device_id.to_string(),
                kind,
                creation_time,
            },
        );
    }

    /// Forget `pid`; its assignment is gone.
    pub fn forget(&self, pid: u32) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.remove(&pid);
    }

    /// The executable name recorded for `pid`, if this run pinned it.
    pub fn exe_name_of(&self, pid: u32) -> Option<String> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.get(&pid).map(|route| route.exe_name.clone())
    }

    /// The endpoint recorded for `pid`, if this run pinned it.
    pub fn device_of(&self, pid: u32) -> Option<String> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.get(&pid).map(|route| route.device_id.clone())
    }

    /// Whether a live route of ours other than `pid`'s serves `exe_name`.
    ///
    /// The assignment Windows keeps is stored per executable, so while one
    /// live route holds it, no other process of the same program may release
    /// it — the release would reach the route's primary endpoint all the same.
    ///
    /// "Live" carries the same witness [`is_routed`] uses: a route whose process
    /// exited stays on the book until a sweep reaches it, and an answer built on
    /// that entry would keep `stop_route` from ever handing the assignment back
    /// and a suspended feed from ever resuming. The other direction — a live
    /// sibling read as dead — is what would take a running route's endpoint away,
    /// so the judgement is the process's own exit code and creation time rather
    /// than the presence of an entry (or, for an entry written without a
    /// creation time, its executable name — see [`entry_process_is_ours`]), and
    /// only entries naming this executable are asked: one `OpenProcess` per
    /// sibling, not one per page of the book.
    pub fn exe_routed_elsewhere(&self, pid: u32, exe_name: &str) -> bool {
        // Snapshot the candidates under the lock and judge them outside of it:
        // `process_is_running` opens a process, and no other path in this crate
        // does system calls while a route book is held.
        let candidates: Vec<(u32, u64, String)> = {
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner
                .iter()
                .filter(|(other, route)| {
                    **other != pid
                        && route.kind == PinKind::Route
                        && route.exe_name.eq_ignore_ascii_case(exe_name)
                })
                .map(|(other, route)| (*other, route.creation_time, route.exe_name.clone()))
                .collect()
        };
        candidates
            .iter()
            .any(|(other, created, exe)| entry_process_is_ours(*other, *created, exe))
    }

    /// The PIDs this book records as routes, whether or not their process still
    /// runs — the kind of the entry, with no liveness witness.
    ///
    /// Exactly one question needs this shape and cannot use [`is_routed`]: the
    /// stale sweep asks whether the entry it is about to drop *was* a route, so
    /// that it can say the executable's render slot came free and resume the
    /// feeds waiting on it. The entry it asks about names a process with no
    /// session right now, so a witnessed answer would come back `no` every time
    /// and no feed would ever resume. Anything else asking "is this routed"
    /// wants [`is_routed`], and nothing else should read this list.
    pub fn routed_pids(&self) -> Vec<u32> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner
            .iter()
            .filter(|(_, route)| route.kind == PinKind::Route)
            .map(|(pid, _)| *pid)
            .collect()
    }

    /// Whether `pid`'s render slot is held by a live device route of ours.
    ///
    /// This is the question a feed asks before writing the carrier over a
    /// program's output. An entry that is not a route is not an answer either:
    /// nothing is being mirrored, and no later `stop_route` will ever resume
    /// what is recorded as waiting for it.
    ///
    /// The entry must also still speak for the process it was written for: a
    /// route whose program exited stays on the book until a sweep reaches it,
    /// and the kernel recycles pids — answering "routed" for a stranger would
    /// suspend every feed set up through that process, with nothing left that
    /// would ever resume it. The bookkeeping itself is left standing either
    /// way; only the answer changes.
    pub fn is_routed(&self, pid: u32) -> bool {
        // Same shape as `exe_routed_elsewhere`: snapshot under the lock,
        // open the process outside of it.
        let entry = {
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner
                .get(&pid)
                .map(|route| (route.kind, route.exe_name.clone(), route.creation_time))
        };
        entry.is_some_and(|(kind, exe, created)| {
            kind == PinKind::Route && entry_process_is_ours(pid, created, &exe)
        })
    }

    /// Take the pinned PIDs and a copy of the entries, for a sweep that will
    /// decide which of them to put back.
    pub fn snapshot(&self) -> Vec<(u32, String, String)> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner
            .iter()
            .map(|(pid, route)| (*pid, route.exe_name.clone(), route.device_id.clone()))
            .collect()
    }

    /// Take every pinned PID, leaving the registry empty. Used on shutdown,
    /// where nothing will retry afterwards.
    pub fn take_all(&self) -> Vec<u32> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut all: Vec<u32> = inner.keys().copied().collect();
        inner.clear();
        drop(inner);
        // Feed pins are ours to hand back too — on shutdown the release walks
        // both data flows anyway, so their PIDs ride the same list. Each book
        // is emptied in turn so no path here ever holds two of them at once.
        for pids in self.take_feed_books() {
            for pid in pids {
                if !all.contains(&pid) {
                    all.push(pid);
                }
            }
        }
        all
    }

    /// Drain both feed books, handing back the PIDs each held. Sources first,
    /// then targets — the order every method here takes them, which is what
    /// keeps the two locks from ever being held at the same time.
    fn take_feed_books(&self) -> [Vec<u32>; 2] {
        fn drain(book: &std::sync::Mutex<std::collections::HashMap<u32, FeedPin>>) -> Vec<u32> {
            let mut book = book.lock().unwrap_or_else(|e| e.into_inner());
            let pids: Vec<u32> = book.keys().copied().collect();
            book.clear();
            pids
        }
        [drain(&self.feed_sources), drain(&self.feed_targets)]
    }

    // ------------------------------------------------------------- feed pins

    /// Record that `pid` is a feed source: its audio is being carried into the
    /// feed carrier, so a removal and a route stop both have a handle on it.
    ///
    /// The endpoint itself is not recorded: the carrier is one configured pair,
    /// and the tap is rebuilt from that configuration whenever the engine that
    /// carries it is restarted.
    pub fn mark_feed(&self, pid: u32, exe_name: &str) {
        let mut book = self.feed_sources.lock().unwrap_or_else(|e| e.into_inner());
        book.insert(pid, FeedPin::new(pid, exe_name));
    }

    /// Record that this app pointed `pid`'s *capture* endpoint at the carrier —
    /// the receiving half of a feed.
    pub fn mark_feed_capture(&self, pid: u32, exe_name: &str) {
        let mut book = self.feed_targets.lock().unwrap_or_else(|e| e.into_inner());
        book.insert(pid, FeedPin::new(pid, exe_name));
    }

    /// The executable name a feed source pin was recorded under, if any.
    pub fn feed_source_exe_of(&self, pid: u32) -> Option<String> {
        let book = self.feed_sources.lock().unwrap_or_else(|e| e.into_inner());
        book.get(&pid).map(|pin| pin.exe_name.clone())
    }

    /// The executable name a feed capture pin was recorded under, if any.
    pub fn feed_capture_exe_of(&self, pid: u32) -> Option<String> {
        let book = self.feed_targets.lock().unwrap_or_else(|e| e.into_inner());
        book.get(&pid).map(|pin| pin.exe_name.clone())
    }

    /// Whether a feed source (render half) pin exists for `pid`.
    pub fn feed_source_of(&self, pid: u32) -> Option<String> {
        self.feed_source_exe_of(pid)
    }

    /// Whether a feed capture pin exists for `pid`.
    pub fn feed_capture_of(&self, pid: u32) -> Option<String> {
        self.feed_capture_exe_of(pid)
    }

    /// Forget a feed source pin.
    pub fn forget_feed_source(&self, pid: u32) {
        let mut book = self.feed_sources.lock().unwrap_or_else(|e| e.into_inner());
        book.remove(&pid);
    }

    /// Forget a feed capture pin.
    pub fn forget_feed_capture(&self, pid: u32) {
        let mut book = self.feed_targets.lock().unwrap_or_else(|e| e.into_inner());
        book.remove(&pid);
    }

    /// Every feed source (render half) pin whose process still runs, as
    /// `(pid, exe_name)`.
    ///
    /// A pin whose program is gone is not offered: its caller writes an endpoint
    /// *through* the pid it names, so a recycled pid would have some other
    /// program pointed at the carrier. The pin itself stays on the book — the
    /// sweep drops it once the process table says so — so nothing is left out
    /// here that a later path still needs.
    pub fn feed_source_pins(&self) -> Vec<(u32, String)> {
        // Judged outside the book lock, like every other liveness question here.
        let candidates: Vec<(u32, u64, String)> = {
            let book = self.feed_sources.lock().unwrap_or_else(|e| e.into_inner());
            book.iter()
                .map(|(pid, pin)| (*pid, pin.creation_time, pin.exe_name.clone()))
                .collect()
        };
        candidates
            .into_iter()
            .filter(|(pid, created, exe)| entry_process_is_ours(*pid, *created, exe))
            .map(|(pid, _, exe)| (pid, exe))
            .collect()
    }

    /// Forget every feed pin whose program is gone. The endpoints those pins
    /// named died with the process, and the rule stays in the feed memory —
    /// that one is the user's, not the process's — so the sweep drops only the
    /// pin.
    ///
    /// "Gone" is the process, not the session list. A program in a long
    /// silence owns no render session at all — a recorder receiving a feed may
    /// never own one — so the session enumeration the sweep already walked is
    /// the wrong witness: dropping on it would strand the assignments the pin
    /// is the only handle to, since `remove_feed_target` refuses to release
    /// without a pin and so would app exit. The process table decides instead,
    /// with the creation time the pin recorded guarding against a recycled pid
    /// (and its executable name standing in when that time was never read).
    pub fn forget_dead_feed_pins(&self) {
        for book in [&self.feed_sources, &self.feed_targets] {
            let mut book = book.lock().unwrap_or_else(|e| e.into_inner());
            book.retain(|pid, pin| entry_process_is_ours(*pid, pin.creation_time, &pin.exe_name));
        }
    }
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
async fn set_process_default_endpoint_flow(
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

    /// A program handed back to the default is not a live route: the settings
    /// reset has to be able to clear that assignment, while only a route keeps
    /// one on purpose.
    #[test]
    fn a_handed_back_program_is_not_a_live_route() {
        let pins = PinnedRoutes::new();
        // `is_routed` also asks whether the entry's process still lives, so the
        // route entry needs a pid that really does: the test process itself.
        let live = std::process::id();
        pins.mark(live, "game.exe", "device-a");
        pins.mark_returned(2, "browser.exe", "device-b");
        pins.mark(3, "quiet.exe", "device-c");
        pins.mark_abandoned(3);

        assert_eq!(pins.routed_pids(), vec![live]);
        assert!(pins.is_routed(live));
        // Both ways an entry can stop being a route answer `no` here, and both
        // still ride the shutdown release.
        assert!(!pins.is_routed(2));
        assert!(!pins.is_routed(3));
        // A route entry whose pid no process answers any more is not a live
        // route either — the pid-recycled stranger a feed must not be suspended
        // for. Its bookkeeping still rides the shutdown release.
        pins.mark(u32::MAX, "gone.exe", "device-d");
        assert!(!pins.is_routed(u32::MAX));

        pins.forget(live);
        // The one thing `routed_pids` is for: a kind answer, whatever the process
        // does now. The sweep reads this list to decide whether the entry it
        // drops was a route whose render slot came free — the pid it asks about
        // has no session by then, so `is_routed` could only ever answer `no`.
        assert_eq!(pins.routed_pids(), vec![u32::MAX]);
        assert!(
            !pins.is_routed(u32::MAX),
            "and it is not read as a live route"
        );
        let mut released = pins.take_all();
        released.sort();
        assert_eq!(released, vec![2, 3, u32::MAX]);
    }

    /// Put one entry on the book the way `mark` cannot: with no creation time,
    /// which is what a process that could not be opened when it was written
    /// leaves behind.
    fn insert_without_a_witness(pins: &PinnedRoutes, pid: u32, exe_name: &str, kind: PinKind) {
        let mut inner = pins.inner.lock().unwrap();
        inner.insert(
            pid,
            PinnedRoute {
                exe_name: exe_name.to_string(),
                device_id: "device".to_string(),
                kind,
                creation_time: 0,
            },
        );
    }

    /// An entry written without a creation time has no exact witness, and
    /// `process_is_running` then judges only the exit code: read that way, *any*
    /// live process holding the pid is credited with the route — which is the
    /// recycling the witness exists to prevent, arriving by a different road. It
    /// must be credited only to the program the entry names, because the
    /// assignment it speaks for is stored per executable.
    #[test]
    fn an_entry_without_a_witness_is_credited_only_to_the_program_it_names() {
        let pins = PinnedRoutes::new();
        let live = std::process::id();
        let own_name = process_name_for_guard(live).expect("the test process can name itself");

        insert_without_a_witness(&pins, live, &own_name, PinKind::Route);
        assert!(
            pins.is_routed(live),
            "the same program running under that pid still holds the assignment"
        );

        // A different program that now answers to the pid is a stranger, however
        // alive — and it must not speak for the executable's reset either.
        insert_without_a_witness(&pins, live, "someone-else.exe", PinKind::Route);
        assert!(!pins.is_routed(live), "a recycled pid is not our route");
        assert!(!pins.exe_routed_elsewhere(999_999, "someone-else.exe"));

        // An entry that cannot even say whose it is has no witness at all.
        insert_without_a_witness(&pins, live, "", PinKind::Route);
        assert!(!pins.is_routed(live));
    }

    /// A feed that has to be put back is rebuilt **through** the pid its pin
    /// names. Offering a pin whose process is gone would start an engine
    /// capturing whatever process holds that pid now — an unrelated programme
    /// sent into someone's microphone — so the list a resume walks carries only
    /// pins that still speak for a live process. The pin itself stays on the
    /// book: the sweep forgets it and exit cleanup still walks it.
    #[test]
    fn a_feed_pin_of_a_gone_process_is_not_offered_for_resume() {
        let pins = PinnedRoutes::new();
        let live = std::process::id();
        pins.mark_feed(live, "sender.exe");
        pins.mark_feed(u32::MAX, "gone.exe");

        let listed = pins.feed_source_pins();
        assert!(
            listed.contains(&(live, "sender.exe".to_string())),
            "a pin whose process runs is offered"
        );
        assert!(
            !listed.iter().any(|(pid, _)| *pid == u32::MAX),
            "a pin whose process is gone is not"
        );
        assert!(
            pins.take_all().contains(&u32::MAX),
            "and it is still on the book to be handed back"
        );
    }

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

    /// A route that died with its process stops holding the executable's
    /// assignment: the sibling question is what keeps `stop_route` from releasing
    /// a live route's endpoint and what makes a feed decide to wait, and an entry
    /// that outlives its process would have both wait for nothing.
    #[test]
    fn a_dead_sibling_does_not_hold_the_programs_assignment() {
        let pins = PinnedRoutes::new();
        let live = std::process::id();
        pins.mark(live, "browser.exe", "device-a");
        // A live route of the same executable holds it, whatever the spelling
        // the two callers happen to have.
        assert!(pins.exe_routed_elsewhere(999_999, "browser.exe"));
        assert!(pins.exe_routed_elsewhere(999_999, "BROWSER.EXE"));
        // The entry's own process is not a sibling of itself.
        assert!(!pins.exe_routed_elsewhere(live, "browser.exe"));

        // A dead one answers no, while its bookkeeping still rides the sweep and
        // the shutdown release.
        pins.mark(u32::MAX, "game.exe", "device-b");
        assert!(!pins.exe_routed_elsewhere(1234, "game.exe"));
        assert!(pins.routed_pids().contains(&u32::MAX));
        assert!(pins.take_all().contains(&u32::MAX));
    }

    /// A chain — `A` into `B`, `B` into `C` — writes `B` on both flows, and
    /// forgetting one half must not lose the other. A pin that goes missing is a
    /// half nothing can hand back any more: the programme keeps receiving or
    /// sending after the board says the feed was removed, which reads as the
    /// removal having worked.
    #[test]
    fn one_program_holds_both_feed_halves() {
        let pins = PinnedRoutes::new();
        pins.mark_feed_capture(20, "b.exe");
        pins.mark_feed(20, "b.exe");

        assert_eq!(
            pins.feed_capture_of(20).as_deref(),
            Some("b.exe"),
            "the capture half outlived having the render half pinned after it"
        );
        assert_eq!(pins.feed_source_of(20).as_deref(), Some("b.exe"));

        pins.forget_feed_source(20);
        assert!(pins.feed_source_of(20).is_none());
        assert!(pins.feed_capture_of(20).is_some());

        // Both books feed the same shutdown list, and a pid in both appears once.
        pins.mark_feed(21, "c.exe");
        let mut all = pins.take_all();
        all.sort();
        assert_eq!(all, vec![20, 21]);
    }

    #[test]
    fn system_processes_are_protected() {
        assert_eq!(routing_refusal(0), Some("a system-critical process"));
        assert_eq!(routing_refusal(4), Some("a system-critical process"));
    }

    /// The guard reads a name it can and refuses only what is on the list — a
    /// readable process that is not one of them stays routable.
    #[test]
    fn an_ordinary_process_is_not_protected() {
        assert_eq!(routing_refusal(std::process::id()), None);
    }

    /// Tickets are handed out in the order the writers arrive, one counter per
    /// slot, and nothing else moves them: a newer ask is by construction the
    /// larger number, and two programs never share a queue.
    #[test]
    fn claims_are_numbered_in_the_order_writers_arrive() {
        let mut clock = std::collections::HashMap::new();
        let chrome: SlotKey = ("chrome.exe".to_string(), E_RENDER);
        let edge: SlotKey = ("msedge.exe".to_string(), E_RENDER);
        assert_eq!(ticket_for(&mut clock, &chrome), 1);
        assert_eq!(ticket_for(&mut clock, &chrome), 2, "the next ask");
        assert_eq!(
            ticket_for(&mut clock, &edge),
            1,
            "another program starts a queue of its own"
        );
        assert_eq!(
            ticket_for(&mut clock, &("chrome.exe".to_string(), E_CAPTURE)),
            1,
            "and so does the other half of the same program's slot"
        );
    }

    /// The whole decision the gate makes, in one table: equal wins, older loses,
    /// and a stamp from anywhere but this program's own half of the slot is not
    /// consulted at all.
    #[test]
    fn only_the_newest_claim_for_a_slot_may_write() {
        let mut clock = std::collections::HashMap::new();
        let chrome: SlotKey = ("chrome.exe".to_string(), E_RENDER);
        for _ in 0..5 {
            ticket_for(&mut clock, &chrome);
        }
        let claim = |key: SlotKey, ticket: u64| SlotClaim { key, ticket };

        assert!(
            claim_is_newest(&clock, &claim(chrome.clone(), 5)),
            "equal counts as newest — the writer that owns the front gets through"
        );
        assert!(
            claim_is_newest(&clock, &claim(chrome.clone(), 6)),
            "a claim ahead of the clock is the same situation, not a loss"
        );
        assert!(
            !claim_is_newest(&clock, &claim(chrome.clone(), 4)),
            "one ask behind loses"
        );
        assert!(
            !claim_is_newest(&clock, &claim(chrome.clone(), 1)),
            "and so does one five asks behind"
        );

        assert!(
            claim_is_newest(&clock, &claim(("msedge.exe".to_string(), E_RENDER), 1)),
            "a slot only another executable has touched is irrelevant here"
        );
        assert!(
            claim_is_newest(&clock, &claim((chrome.0.clone(), E_CAPTURE), 1)),
            "the capture half is ordered apart from the render half of the same program"
        );
        assert!(
            claim_is_newest(&clock, &claim(("never-asked.exe".to_string(), E_RENDER), 9)),
            "a slot the clock has never seen is nothing to lose to"
        );
    }

    /// The gate holds the slot for the newest claim and refuses an older one — and
    /// holding it is what makes the check mean something: no ticket can be handed
    /// out while a writer is inside the slot, so a claim that passes never loses
    /// afterwards, and one that loses never wrote at all.
    #[test]
    fn the_gate_holds_the_slot_for_the_newest_claim_only() {
        let live = std::process::id();
        // Asked for a flow this program's own process can be named for, which is
        // the same witness the write path uses.
        let first = claim_endpoint_slot(live, E_CAPTURE).expect("the test process can name itself");
        match hold_slot(Some(&first)) {
            SlotHold::Open(hold) => assert!(hold.is_some(), "the newest claim holds its slot"),
            SlotHold::Superseded(_, newest) => {
                panic!("the first ask for a quiet slot lost it at #{newest}")
            }
        }

        let second = claim_endpoint_slot(live, E_CAPTURE).expect("the same program again");
        assert!(
            second.ticket > first.ticket,
            "the newer ask carries the larger ticket"
        );
        assert!(
            matches!(
                hold_slot(Some(&first)),
                SlotHold::Superseded(_, newest) if newest == second.ticket
            ),
            "and the ask it replaced is refused, naming who beat it"
        );
        match hold_slot(Some(&second)) {
            SlotHold::Open(hold) => assert!(hold.is_some(), "the newer claim still stands"),
            SlotHold::Superseded(_, newest) => panic!("the newest claim was refused at #{newest}"),
        }

        // A slot this side cannot name is not ordered — the release paths that walk
        // a process which has already gone must not be refused a hand-back.
        assert!(matches!(hold_slot(None), SlotHold::Open(None)));
    }

    /// One release walk speaks for a program's slot once, even when it is handed
    /// two of that program's processes: with a second ticket, the walk's own first
    /// release would be the older claim and get refused, so the walk would supersede
    /// itself and report one program handed back while it is still pinned.
    #[test]
    fn one_walk_holds_one_claim_per_slot() {
        let live = std::process::id();
        let mut held = std::collections::HashMap::new();
        let first =
            claim_walked_slot(live, E_RENDER, &mut held).expect("the test process can name itself");
        // The second process of one program is not something a unit test can conjure,
        // so the same pid is asked twice — which reaches the same slot by the same
        // road, and is the shape that used to take the second ticket.
        let again = claim_walked_slot(live, E_RENDER, &mut held).expect("the same program again");
        assert_eq!(first.ticket, again.ticket, "one slot, one ticket");
        assert_eq!(
            held.len(),
            1,
            "and the walk keys it by the slot, not the pid"
        );

        // The other half of the same program's assignment is a different slot, so a
        // walk that means it takes its own hold. The two tickets are not compared:
        // the clock numbers each slot on its own — a stamp from the recording half
        // deliberately says nothing about the playback one (see `claim_is_newest`),
        // so the two counters mean nothing to each other.
        let capture = claim_walked_slot(live, E_CAPTURE, &mut held)
            .expect("the same process, the recording half");
        assert_eq!(
            capture.key.1, E_CAPTURE,
            "the recording half is its own slot"
        );
        assert_eq!(held.len(), 2, "one hold per slot");
        let capture_again = claim_walked_slot(live, E_CAPTURE, &mut held)
            .expect("the same process, the recording half again");
        assert_eq!(
            capture.ticket, capture_again.ticket,
            "and a walk keeps the hold it already has on it"
        );
    }

    /// A writer that loses the slot has to say so in words that are not a service
    /// failure: the caller's rollback turns on which of the two happened, and the
    /// user reads this string as the whole explanation of a route that did not land.
    #[test]
    fn a_superseded_write_names_the_program_and_says_what_beat_it() {
        let render = SlotClaim {
            key: ("chrome.exe".to_string(), E_RENDER),
            ticket: 4,
        };
        let message = superseded_error(&render, 6).to_string();
        assert!(
            message.contains("superseded"),
            "the phrase the caller sorts on"
        );
        assert!(
            message.contains("chrome.exe"),
            "and the program it lost: {message}"
        );
        assert!(
            message.contains("render"),
            "and which half of its slot: {message}"
        );

        let capture = SlotClaim {
            key: ("recorder.exe".to_string(), E_CAPTURE),
            ticket: 1,
        };
        let message = superseded_error(&capture, 2).to_string();
        assert!(
            message.contains("capture") && message.contains("recorder.exe"),
            "the other half reads differently: {message}"
        );
    }

    /// The capture half of a feed pair is only registered under the capture
    /// class: wrapping it in the render class is exactly the write that came
    /// back `E_INVALIDARG` (0x80070057) when a feed rule was recorded.
    #[test]
    fn each_flow_wraps_in_its_own_interface_class() {
        let id = "{0.0.1.00000000}.{516edd6f-fe3d-4ff3-a66a-d240838187d7}";
        let capture = wrap_device_id_candidates(id, E_CAPTURE);
        assert_eq!(
            capture,
            vec![format!("{MMDEVAPI_TOKEN}{id}{CAPTURE_DEVICE_INTERFACE}")]
        );

        let id = "{0.0.0.00000000}.{1c1b1e0d-e0e3-41de-915c-5db74e4b693a}";
        let render = wrap_device_id_candidates(id, E_RENDER);
        // The render class is the common registration and goes first; the
        // alternate is offered for the endpoints registered only under it.
        assert_eq!(
            render,
            vec![
                format!("{MMDEVAPI_TOKEN}{id}{RENDER_DEVICE_INTERFACE}"),
                format!("{MMDEVAPI_TOKEN}{id}{ALT_RENDER_DEVICE_INTERFACE}"),
            ]
        );
    }

    /// Whatever class a call succeeded with, what `GetPersistedDefault` hands
    /// back is read as the plain endpoint id the rest of the app speaks.
    #[test]
    fn every_wrapped_form_unwraps_to_the_endpoint_id() {
        let id = "{0.0.0.00000000}.{1c1b1e0d-e0e3-41de-915c-5db74e4b693a}";
        for suffix in [
            RENDER_DEVICE_INTERFACE,
            CAPTURE_DEVICE_INTERFACE,
            ALT_RENDER_DEVICE_INTERFACE,
        ] {
            let wrapped = format!("{MMDEVAPI_TOKEN}{id}{suffix}");
            assert_eq!(unwrap_device_id(&wrapped), id);
            // An id that arrives already wrapped is passed through untouched.
            assert_eq!(wrap_device_id_candidates(&wrapped, E_RENDER), vec![wrapped]);
        }
    }
}
