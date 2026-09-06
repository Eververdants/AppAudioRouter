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
//!      behavior as the Settings UI).
//!    - Vtable slot 27 is `ClearAllPersistedApplicationDefaultEndpoints()`.
//!
//! 2. System-wide default — `CPolicyConfigClient` coclass with interface
//!    `{4495581a-…}` (the object the OS volume mixer uses); vtable slot 13 is
//!    `SetDefaultEndpoint(deviceId: PCWSTR, role: i32)`.

use log::info;
use windows::core::{GUID, HSTRING, PCWSTR};

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

// ERole values used by the policy API.
const ROLE_CONSOLE: i32 = 0;
const ROLE_MULTIMEDIA: i32 = 1;
const ROLE_COMMUNICATIONS: i32 = 2;

// Vtable slots of IAudioPolicyConfigFactory (0-based incl. IUnknown/IInspectable).
const SLOT_SET_PERSISTED_DEFAULT: usize = 25;

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

/// Handle to the activated `IAudioPolicyConfigFactory` interface.
struct AudioPolicyConfig {
    obj: *mut core::ffi::c_void,
    vtable: usize,
}

impl AudioPolicyConfig {
    /// Activate the factory and QI to the build-specific interface.
    fn activate() -> Result<Self, String> {
        use std::os::windows::ffi::OsStrExt;

        extern "system" {
            fn LoadLibraryW(name: *const u16) -> isize;
            fn GetProcAddress(module: isize, name: *const u8) -> isize;
        }

        // SAFETY: loading a system DLL and resolving its export.
        let module = unsafe {
            let name: Vec<u16> = std::ffi::OsStr::new("AudioSes.dll\0")
                .encode_wide()
                .collect();
            LoadLibraryW(name.as_ptr())
        };
        if module == 0 {
            return Err("LoadLibraryW(AudioSes.dll) failed".to_string());
        }
        // SAFETY: export name is a valid NUL-terminated literal.
        let proc_addr =
            unsafe { GetProcAddress(module, c"DllGetActivationFactory".as_ptr() as *const u8) };
        if proc_addr == 0 {
            return Err("AudioSes.dll does not export DllGetActivationFactory".to_string());
        }
        type DllGetActivationFactoryFn =
            unsafe extern "system" fn(isize, *mut *mut core::ffi::c_void) -> windows::core::HRESULT;
        // SAFETY: WinRT activation contract signature.
        let dll_get_factory: DllGetActivationFactoryFn = unsafe { core::mem::transmute(proc_addr) };

        let class_hstring = HSTRING::from(AUDIO_POLICY_CONFIG_CLASS);
        let mut raw: *mut core::ffi::c_void = std::ptr::null_mut();
        // SAFETY: valid HSTRING and out pointer; factory released in Drop.
        let hr = unsafe { dll_get_factory(hstring_handle(&class_hstring), &mut raw) };
        if hr.is_err() || raw.is_null() {
            return Err(format!("DllGetActivationFactory failed: 0x{:08X}", hr.0));
        }

        let vtable = unsafe { *(raw as *const usize) };
        let target_iid = Self::discover_interface_iid(raw, vtable)?;
        Self::query_interface(raw, &target_iid)
    }

    /// Discover the build-specific factory IID via `IInspectable::GetIids`,
    /// preferring known IIDs; falls back to the last discovered IID.
    fn discover_interface_iid(
        raw: *mut core::ffi::c_void,
        vtable: usize,
    ) -> Result<GUID, String> {
        type GetIidsFn = unsafe extern "system" fn(
            this: *mut core::ffi::c_void,
            iid_count: *mut u32,
            iids: *mut *mut GUID,
        ) -> windows::core::HRESULT;

        // SAFETY: GetIids is IInspectable slot 3.
        let get_iids: GetIidsFn = unsafe { core::mem::transmute(*((vtable + 3 * 8) as *const usize)) };
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
        Err("IAudioPolicyConfigFactory IID not discovered (GetIids failed)".to_string())
    }

    /// QueryInterface the activation factory for `iid`.
    fn query_interface(raw: *mut core::ffi::c_void, iid: &GUID) -> Result<Self, String> {
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
            return Err(format!(
                "QueryInterface(IAudioPolicyConfigFactory {:?}) failed: 0x{:08X}",
                iid, hr.0
            ));
        }
        let vtable = unsafe { *(obj as *const usize) };
        Ok(Self { obj, vtable })
    }

    /// Set the persisted default render endpoint of a process for one role.
    fn set_persisted_default(
        &self,
        process_id: u32,
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
                E_RENDER,
                role,
                hstring_handle(device_hstring),
            )
        }
    }
}

impl Drop for AudioPolicyConfig {
    fn drop(&mut self) {
        // SAFETY: Release balances the QI reference taken in query_interface.
        unsafe {
            let release: unsafe extern "system" fn(*mut core::ffi::c_void) -> u32 =
                core::mem::transmute(*((self.vtable + 2 * 8) as *const usize));
            release(self.obj);
        }
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

fn role_values(role: Role) -> &'static [i32] {
    match role {
        Role::Console => &[ROLE_CONSOLE],
        Role::Multimedia => &[ROLE_MULTIMEDIA],
        Role::Communications => &[ROLE_COMMUNICATIONS],
        Role::All => &[ROLE_CONSOLE, ROLE_MULTIMEDIA, ROLE_COMMUNICATIONS],
    }
}

/// Set the default audio device for a single process (by PID).
///
/// The assignment is persisted by the audio service per executable and applies
/// to audio sessions started after this call (identical to the Windows 11
/// Settings "app volume and device preferences" toggle).
pub fn set_process_default_device(device_id: &str, pid: u32, role: Role) -> Result<(), String> {
    if pid == 0 {
        return Err("invalid pid".to_string());
    }
    let device_id = device_id.to_string();
    // DllGetActivationFactory of AudioSes returns CLASS_E_CLASSNOTAVAILABLE on
    // an STA thread (Tauri sync commands run on the main thread, which WebView2
    // initializes as STA); run the whole activation on a dedicated MTA thread.
    std::thread::spawn(move || {
        let com_owned = crate::audio::init_com()?;

        let result = (|| -> Result<(), String> {
            let policy = AudioPolicyConfig::activate()?;
            let wrapped = HSTRING::from(wrap_device_id(&device_id));
            let mut ok = 0;
            let mut last_err: Option<windows::core::HRESULT> = None;
            for &r in role_values(role) {
                let hr = policy.set_persisted_default(pid, r, &wrapped);
                if hr.is_ok() {
                    ok += 1;
                } else {
                    last_err = Some(hr);
                }
            }
            if ok == 0 {
                let hr = last_err.unwrap();
                return Err(format!(
                    "SetPersistedDefaultAudioEndpoint failed: 0x{:08X}",
                    hr.0
                ));
            }
            info!("routed PID {pid} to device {device_id} (roles ok: {ok})");
            Ok(())
        })();

        crate::audio::uninit_com(com_owned);

        result
    })
    .join()
    .map_err(|_| "routing thread panicked".to_string())?
}

// ---------------------------------------------------------------------------
// System-wide default
// ---------------------------------------------------------------------------

const CLSID_POLICY_CONFIG_CLIENT: GUID = GUID::from_values(
    0x870af99c, 0x171d, 0x4f9e, [0xaf, 0x0d, 0xe6, 0x3d, 0xf4, 0x0c, 0x2b, 0xc9],
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
    fn new() -> Result<Self, String> {
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
            return Err(format!(
                "CoCreateInstance(IPolicyConfig) failed: 0x{:08X}",
                hr.0
            ));
        }
        Ok(Self { obj: ppv })
    }

    /// Access the object's vtable (double deref: object -> vtable pointer).
    fn vtable(&self) -> &PolicyConfigVtable {
        // SAFETY: COM objects start with a pointer to their vtable.
        unsafe { &**(self.obj as *const *const PolicyConfigVtable) }
    }

    /// Set the system-wide default render endpoint for a role.
    fn set_default_endpoint(&self, device_id: &str, role: i32) -> Result<(), String> {
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
            return Err(format!("SetDefaultEndpoint failed: 0x{:08X}", hr.0));
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
pub fn set_default_device(device_id: &str, role: Role) -> Result<(), String> {
    let device_id = device_id.to_string();
    // Keep both routing channels off the main STA thread for consistency.
    std::thread::spawn(move || {
        let com_owned = crate::audio::init_com()?;

        let result = (|| -> Result<(), String> {
            let policy = PolicyConfig::new()?;
            let role_i32 = match role {
                Role::Console => ROLE_CONSOLE,
                Role::Multimedia => ROLE_MULTIMEDIA,
                Role::Communications => ROLE_COMMUNICATIONS,
                Role::All => ROLE_MULTIMEDIA,
            };
            policy.set_default_endpoint(&device_id, role_i32)?;
            info!("set default device {device_id} (role={role:?})");
            Ok(())
        })();

        crate::audio::uninit_com(com_owned);

        result
    })
    .join()
    .map_err(|_| "routing thread panicked".to_string())?
}

