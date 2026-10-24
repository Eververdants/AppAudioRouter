//! The one COM channel this module writes through: the undocumented WinRT
//! activatable class `Windows.Media.Internal.AudioPolicyConfig`, reached via
//! `AudioSes.dll!DllGetActivationFactory` and driven by raw vtable slots — the
//! module docs of [`super`] say what each slot means and why this is the only
//! channel. Two halves live here: the handle (`AudioPolicyConfig`, its
//! activation, IID discovery, `QueryInterface`, the three slot calls and the
//! `Drop` balancing the QI reference) and the device-id wrapping (the service
//! is addressed by the endpoint's device-interface symlink, not by the plain
//! endpoint id the rest of the app speaks). Nothing outside this module
//! activates the factory or calls a slot: the only door is
//! [`super::endpoints`], which sits above it.

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
pub(super) const E_RENDER: i32 = 0;
// The capture half of the same policy API: a program's default *recording*
// endpoint is pinned through the identical slot, addressed by data flow.
pub(super) const E_CAPTURE: i32 = 1;

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
pub(super) struct AudioPolicyConfig {
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
    pub(super) fn activate() -> Result<Self, AudioError> {
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
    pub(super) fn set_persisted_default(
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
    pub(super) fn clear_persisted_default(
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
    pub(super) fn get_persisted_default(
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
pub(super) fn wrap_device_id_candidates(device_id: &str, data_flow: i32) -> Vec<String> {
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

pub(super) fn role_values(role: Role) -> &'static [i32] {
    match role {
        Role::All => &[ROLE_CONSOLE, ROLE_MULTIMEDIA, ROLE_COMMUNICATIONS],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
