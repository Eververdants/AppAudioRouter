//! Audio device routing.
//!
//! Two channels, both verified on Windows 11 24H2 (build 26100):
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
//!      symlink: `\\?\SWD#MMDEVAPI#{<endpoint id>}#{e6327cad-…}`.
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
//! 2. System-wide default — `CPolicyConfigClient` coclass with interface
//!    `{4495581a-…}` (the object the OS volume mixer uses); vtable slot 13 is
//!    `SetDefaultEndpoint(deviceId: PCWSTR, role: i32)`.

use log::info;
use windows::core::{GUID, HSTRING, PCWSTR};

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

// Device-interface id appended after the endpoint id for render endpoints.
const RENDER_DEVICE_INTERFACE: &str = "#{e6327cad-dcec-4949-ae8a-991e976a79d2}";
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
/// symlink form expected by `SetPersistedDefaultAudioEndpoint`.
fn wrap_device_id(device_id: &str) -> String {
    if device_id.starts_with(MMDEVAPI_TOKEN) {
        return device_id.to_string();
    }
    format!("{MMDEVAPI_TOKEN}{device_id}{RENDER_DEVICE_INTERFACE}")
}

/// Turn a device-interface symlink back into the plain endpoint id the rest of
/// the app (and the Windows volume mixer) uses.
fn unwrap_device_id(device_id: &str) -> String {
    let trimmed = device_id.strip_prefix(MMDEVAPI_TOKEN).unwrap_or(device_id);
    trimmed
        .strip_suffix(RENDER_DEVICE_INTERFACE)
        .unwrap_or(trimmed)
        .to_string()
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
        Role::Console => &[ROLE_CONSOLE],
        Role::Multimedia => &[ROLE_MULTIMEDIA],
        Role::Communications => &[ROLE_COMMUNICATIONS],
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
}

/// One feed endpoint this run pinned. Which of the two halves it is comes from
/// the book it lives in, not from a field: one pid can hold both at once, when
/// it receives one program's sound and feeds another's.
#[derive(Debug, Clone)]
pub struct FeedPin {
    pub exe_name: String,
    pub device_id: String,
    /// The process's creation time when this pin was written. The pid is the
    /// only handle the release paths get, and the kernel hands pids to new
    /// processes — this is what tells the sweep that a pin's pid still names
    /// the process the pin speaks for.
    pub creation_time: u64,
}

impl FeedPin {
    fn new(pid: u32, exe_name: &str, device_id: &str) -> Self {
        Self {
            exe_name: exe_name.to_string(),
            device_id: device_id.to_string(),
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
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.insert(
            pid,
            PinnedRoute {
                exe_name: exe_name.to_string(),
                device_id: device_id.to_string(),
                kind,
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
    pub fn exe_routed_elsewhere(&self, pid: u32, exe_name: &str) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.iter().any(|(other, route)| {
            *other != pid
                && route.kind == PinKind::Route
                && route.exe_name.eq_ignore_ascii_case(exe_name)
        })
    }

    /// The PIDs a live route of ours owns, whose assignments must be left alone.
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
    pub fn is_routed(&self, pid: u32) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner
            .get(&pid)
            .is_some_and(|route| route.kind == PinKind::Route)
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

    /// Record that this app pointed `pid`'s *render* endpoint at the carrier,
    /// which is how a feed source is wired.
    pub fn mark_feed(&self, pid: u32, exe_name: &str, device_id: &str) {
        let mut book = self.feed_sources.lock().unwrap_or_else(|e| e.into_inner());
        book.insert(pid, FeedPin::new(pid, exe_name, device_id));
    }

    /// Record that this app pointed `pid`'s *capture* endpoint at the carrier —
    /// the receiving half of a feed.
    pub fn mark_feed_capture(&self, pid: u32, exe_name: &str, device_id: &str) {
        let mut book = self.feed_targets.lock().unwrap_or_else(|e| e.into_inner());
        book.insert(pid, FeedPin::new(pid, exe_name, device_id));
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

    /// The render endpoint a feed source pin was recorded against.
    pub fn feed_source_device_of(&self, pid: u32) -> Option<String> {
        let book = self.feed_sources.lock().unwrap_or_else(|e| e.into_inner());
        book.get(&pid).map(|pin| pin.device_id.clone())
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

    /// Every feed source (render half) pin, as `(pid, exe_name)`.
    pub fn feed_source_pins(&self) -> Vec<(u32, String)> {
        let book = self.feed_sources.lock().unwrap_or_else(|e| e.into_inner());
        book.iter()
            .map(|(pid, pin)| (*pid, pin.exe_name.clone()))
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
    /// with the creation time the pin recorded guarding against a recycled pid.
    pub fn forget_dead_feed_pins(&self) {
        for book in [&self.feed_sources, &self.feed_targets] {
            let mut book = book.lock().unwrap_or_else(|e| e.into_inner());
            book.retain(|pid, pin| super::process_is_running(*pid, pin.creation_time));
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
fn release_endpoints_of_flow(
    pids: &[u32],
    role: Role,
    capture: bool,
) -> Result<Vec<(u32, ReleaseOutcome)>, AudioError> {
    let com_owned = crate::audio::init_com()?;
    let flow = if capture { E_CAPTURE } else { E_RENDER };

    let result = (|| -> Result<Vec<(u32, ReleaseOutcome)>, AudioError> {
        let policy = AudioPolicyConfig::activate()?;
        let mut outcomes = Vec::with_capacity(pids.len());
        for &pid in pids {
            if pid == 0 {
                continue;
            }
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
    // DllGetActivationFactory of AudioSes returns CLASS_E_CLASSNOTAVAILABLE on
    // an STA thread (Tauri sync commands run on the main thread, which WebView2
    // initializes as STA); run the whole activation on a dedicated MTA thread.
    tokio::task::spawn_blocking(move || {
        let com_owned = crate::audio::init_com()?;

        let result = (|| -> Result<(), AudioError> {
            let policy = AudioPolicyConfig::activate()?;
            let wrapped = HSTRING::from(wrap_device_id(&device_id));
            let mut ok = 0;
            let mut last_err: Option<windows::core::HRESULT> = None;
            for &r in role_values(role) {
                let hr = policy.set_persisted_default(pid, data_flow, r, &wrapped);
                if hr.is_ok() {
                    ok += 1;
                } else {
                    last_err = Some(hr);
                }
            }
            if ok == 0 {
                let hr = last_err.unwrap();
                return Err(AudioError::Api(format!(
                    "SetPersistedDefaultAudioEndpoint failed: 0x{:08X}",
                    hr.0
                )));
            }
            let what = if data_flow == E_CAPTURE {
                "capture"
            } else {
                "render"
            };
            info!("pinned PID {pid} {what} endpoint to device {device_id} (roles ok: {ok})");
            Ok(())
        })();

        crate::audio::uninit_com(com_owned);

        result
    })
    .await
    .map_err(|_| AudioError::Api("routing task failed".to_string()))?
}

// ---------------------------------------------------------------------------
// System-wide default
// ---------------------------------------------------------------------------

const CLSID_POLICY_CONFIG_CLIENT: GUID = GUID::from_values(
    0x870af99c,
    0x171d,
    0x4f9e,
    [0xaf, 0x0d, 0xe6, 0x3d, 0xf4, 0x0c, 0x2b, 0xc9],
);
const IID_IPOLICY_CONFIG: GUID = GUID::from_u128(0x4495581a_01b9_4a8f_b05c_741a6c983d28);

/// Wrapper around a raw `IPolicyConfig` COM pointer.
struct PolicyConfig {
    obj: *mut core::ffi::c_void,
}

#[allow(non_snake_case)]
#[repr(C)]
struct PolicyConfigVtable {
    // IUnknown (slots 0-2)
    QueryInterface: usize,
    AddRef: unsafe extern "system" fn(*mut core::ffi::c_void) -> u32,
    Release: unsafe extern "system" fn(*mut core::ffi::c_void) -> u32,
    // Classic IPolicyConfig prefix (slots 3-14, layout of {f8679f50})
    GetMixFormat: usize,        // 3
    GetDeviceFormat: usize,     // 4
    ResetDeviceFormat: usize,   // 5
    SetDeviceFormat: usize,     // 6
    GetProcessingPeriod: usize, // 7
    SetProcessingPeriod: usize, // 8
    GetSharingMode: usize,      // 9
    SetSharingMode: usize,      // 10
    GetPropertyValue: usize,    // 11
    SetPropertyValue: usize,    // 12
    SetDefaultEndpoint: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        PCWSTR, // device id
        i32,    // ERole
    ) -> windows::core::HRESULT, // 13
    SetEndpointVisibility: usize, // 14
                                // Extended slots (15+) are build-specific; never call them.
}

impl PolicyConfig {
    /// Create the CPolicyConfigClient instance for the modern interface.
    fn new() -> Result<Self, AudioError> {
        #[link(name = "ole32")]
        extern "system" {
            fn CoCreateInstance(
                rclsid: *const GUID,
                punkouter: *mut core::ffi::c_void,
                dwclscontext: u32,
                riid: *const GUID,
                ppv: *mut *mut core::ffi::c_void,
            ) -> windows::core::HRESULT;
        }
        const CLSCTX_ALL: u32 = 0x1 | 0x2 | 0x4 | 0x10;
        let mut ppv: *mut core::ffi::c_void = std::ptr::null_mut();
        // SAFETY: registered coclass/interface pair; ppv released in Drop.
        let hr = unsafe {
            CoCreateInstance(
                &CLSID_POLICY_CONFIG_CLIENT,
                std::ptr::null_mut(),
                CLSCTX_ALL,
                &IID_IPOLICY_CONFIG,
                &mut ppv,
            )
        };
        if hr.is_err() {
            return Err(AudioError::Api(format!(
                "CoCreateInstance(IPolicyConfig) failed: 0x{:08X}",
                hr.0
            )));
        }
        Ok(Self { obj: ppv })
    }

    /// Access the object's vtable (double deref: object -> vtable pointer).
    fn vtable(&self) -> &PolicyConfigVtable {
        // SAFETY: COM objects start with a pointer to their vtable.
        unsafe { &**(self.obj as *const *const PolicyConfigVtable) }
    }

    /// Set the system-wide default render endpoint for a role.
    fn set_default_endpoint(&self, device_id: &str, role: i32) -> Result<(), AudioError> {
        use std::os::windows::ffi::OsStrExt;
        let dev_w: Vec<u16> = std::ffi::OsStr::new(device_id)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: slot 13 signature verified against this interface; dev_w
        // outlives the call.
        let hr =
            unsafe { (self.vtable().SetDefaultEndpoint)(self.obj, PCWSTR(dev_w.as_ptr()), role) };
        if hr.is_err() {
            return Err(AudioError::Api(format!(
                "SetDefaultEndpoint failed: 0x{:08X}",
                hr.0
            )));
        }
        Ok(())
    }
}

impl Drop for PolicyConfig {
    fn drop(&mut self) {
        // SAFETY: Release balances the CoCreateInstance reference.
        unsafe { (self.vtable().Release)(self.obj) };
    }
}

/// Set the system default audio device (applies to apps using the default).
pub async fn set_default_device(device_id: &str, role: Role) -> Result<(), AudioError> {
    validate_device_id(device_id)?;
    let device_id = device_id.to_string();
    // Keep both routing channels off the main STA thread for consistency.
    tokio::task::spawn_blocking(move || {
        let com_owned = crate::audio::init_com()?;

        let result = (|| -> Result<(), AudioError> {
            let policy = PolicyConfig::new()?;
            for &r in role_values(role) {
                policy.set_default_endpoint(&device_id, r)?;
            }
            info!("set default device {device_id} (role={role:?})");
            Ok(())
        })();

        crate::audio::uninit_com(com_owned);

        result
    })
    .await
    .map_err(|_| AudioError::Api("routing task failed".to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A program handed back to the default is not a live route: the settings
    /// reset has to be able to clear that assignment, while only a route keeps
    /// one on purpose.
    #[test]
    fn a_handed_back_program_is_not_a_live_route() {
        let pins = PinnedRoutes::new();
        pins.mark(1, "game.exe", "device-a");
        pins.mark_returned(2, "browser.exe", "device-b");
        pins.mark(3, "quiet.exe", "device-c");
        pins.mark_abandoned(3);

        assert_eq!(pins.routed_pids(), vec![1]);
        assert!(pins.is_routed(1));
        // Both ways an entry can stop being a route answer `no` here, and both
        // still ride the shutdown release.
        assert!(!pins.is_routed(2));
        assert!(!pins.is_routed(3));

        pins.forget(1);
        assert!(pins.routed_pids().is_empty());
        let mut released = pins.take_all();
        released.sort();
        assert_eq!(released, vec![2, 3]);
    }

    /// A chain — `A` into `B`, `B` into `C` — writes `B` on both flows, and
    /// forgetting one half must not lose the other. A pin that goes missing is
    /// an endpoint nothing can hand back any more: the program stays on the
    /// carrier after the board says the feed was removed, which reads as the
    /// removal having worked.
    #[test]
    fn one_program_holds_both_feed_halves() {
        let pins = PinnedRoutes::new();
        pins.mark_feed_capture(20, "b.exe", "carrier-capture");
        pins.mark_feed(20, "b.exe", "carrier-render");

        assert_eq!(
            pins.feed_capture_of(20).as_deref(),
            Some("b.exe"),
            "the capture half outlived having the render half pinned after it"
        );
        assert_eq!(
            pins.feed_source_device_of(20).as_deref(),
            Some("carrier-render")
        );

        pins.forget_feed_source(20);
        assert!(pins.feed_source_of(20).is_none());
        assert!(pins.feed_capture_of(20).is_some());

        // Both books feed the same shutdown list, and a pid in both appears once.
        pins.mark_feed(21, "c.exe", "carrier-render");
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
}
