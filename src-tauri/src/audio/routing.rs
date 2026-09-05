//! Per-app default audio device routing.
//!
//! Wraps the undocumented-but-stable COM interface `IPolicyConfigVista`.
//! This is the same interface NirSoft SoundVolumeView uses for /SetAppDefault.
//!
//! Reference: AudioRouter / EarTrumpet / modern MMDevice API wrappers.

use log::info;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::core::{GUID, HRESULT, PCWSTR};

use crate::audio::Role;

// CLSID_PolicyConfigVistaClient
const CLSID_POLICY_CONFIG_VISTA: GUID = GUID::from_values(
    0x294935ce, 0xf637, 0x4e7c, [0xa4, 0x1b, 0xab, 0x25, 0x54, 0x60, 0xb8, 0x62],
);

// IID_IPolicyConfigVista
const IID_IPOLICY_CONFIG_VISTA: GUID = GUID::from_values(
    0xf8679f50, 0x850a, 0x41cf, [0x9c, 0x72, 0x43, 0x0f, 0x29, 0x02, 0x90, 0xc8],
);

/// IPolicyConfigVista COM interface.
///
/// We define the vtable manually because it is not in the `windows` crate.
#[repr(C)]
pub struct IPolicyConfigVista {
    vtable: *const IPolicyConfigVistaVtable,
}

#[allow(non_snake_case)]
#[repr(C)]
pub struct IPolicyConfigVistaVtable {
    // IUnknown (0-2)
    QueryInterface: unsafe extern "system" fn(*mut core::ffi::c_void, *const GUID, *mut *mut core::ffi::c_void) -> HRESULT,
    AddRef: unsafe extern "system" fn(*mut core::ffi::c_void) -> u32,
    Release: unsafe extern "system" fn(*mut core::ffi::c_void) -> u32,
    // IPolicyConfigVista (3-18)
    GetMixFormat: unsafe extern "system" fn(*mut core::ffi::c_void, PCWSTR, *mut *mut core::ffi::c_void) -> HRESULT,
    GetDeviceFormat: unsafe extern "system" fn(*mut core::ffi::c_void, PCWSTR, i32, *mut *mut core::ffi::c_void) -> HRESULT,
    SetDeviceFormat: unsafe extern "system" fn(*mut core::ffi::c_void, PCWSTR, *mut core::ffi::c_void, *mut core::ffi::c_void) -> HRESULT,
    GetProcessingPeriod: unsafe extern "system" fn(*mut core::ffi::c_void, PCWSTR, i32, *mut i64, *mut i64) -> HRESULT,
    SetProcessingPeriod: unsafe extern "system" fn(*mut core::ffi::c_void, PCWSTR, *mut i64) -> HRESULT,
    GetSharingMode: unsafe extern "system" fn(*mut core::ffi::c_void, PCWSTR, *mut core::ffi::c_void) -> HRESULT,
    SetSharingMode: unsafe extern "system" fn(*mut core::ffi::c_void, PCWSTR, *mut core::ffi::c_void) -> HRESULT,
    GetPropertyValue: unsafe extern "system" fn(*mut core::ffi::c_void, PCWSTR, *const core::ffi::c_void, *mut core::ffi::c_void) -> HRESULT,
    SetPropertyValue: unsafe extern "system" fn(*mut core::ffi::c_void, PCWSTR, *const core::ffi::c_void, *mut core::ffi::c_void) -> HRESULT,
    SetDefaultEndpoint: unsafe extern "system" fn(*mut core::ffi::c_void, PCWSTR, i32) -> HRESULT,
    SetEndpointVisibility: unsafe extern "system" fn(*mut core::ffi::c_void, PCWSTR, i32) -> HRESULT,
    SetEndpointTooltip: unsafe extern "system" fn(*mut core::ffi::c_void, PCWSTR, PCWSTR) -> HRESULT,
    SetAppDefaultAudioEndpoint: unsafe extern "system" fn(*mut core::ffi::c_void, PCWSTR, i32, PCWSTR) -> HRESULT,
    RemoveDefaultEndpoint: unsafe extern "system" fn(*mut core::ffi::c_void, PCWSTR) -> HRESULT,
    RemoveAppDefaultEndpoint: unsafe extern "system" fn(*mut core::ffi::c_void, PCWSTR, PCWSTR) -> HRESULT,
    SetPersistedDefaultEndpoint: unsafe extern "system" fn(*mut core::ffi::c_void, PCWSTR, PCWSTR) -> HRESULT,
    RemovePersistedDefaultEndpoint: unsafe extern "system" fn(*mut core::ffi::c_void, PCWSTR, PCWSTR) -> HRESULT,
}

// ERole values
const eConsole: i32 = 0;
const eMultimedia: i32 = 1;
const eCommunications: i32 = 2;

impl IPolicyConfigVista {
    /// Create a new IPolicyConfigVista instance.
    pub fn new() -> Result<Self, String> {
        // SAFETY: CoCreateInstance with known CLSID.
        let raw: *mut core::ffi::c_void = unsafe {
            let mut instance = std::mem::zeroed::<*mut core::ffi::c_void>();
            windows::Win32::System::Com::CoCreateInstance(
                &CLSID_POLICY_CONFIG_VISTA,
                None,
                CLSCTX_ALL,
                &IID_IPOLICY_CONFIG_VISTA,
                &mut instance,
            )
            .map(|_| instance)
            .map_err(|e| format!("CoCreateInstance(IPolicyConfigVista) failed: {e}"))?
        };

        if raw.is_null() {
            return Err("CoCreateInstance returned null".to_string());
        }

        // SAFETY: The instance is a valid COM object with a vtable.
        Ok(Self {
            vtable: unsafe { *(raw as *const *const IPolicyConfigVistaVtable) },
        })
    }

    /// Set the default audio endpoint for a specific process (by PID).
    ///
    /// `device_id` is the IMMDevice endpoint ID string.
    /// `target_pid_str` is the PID formatted as a wide string.
    pub fn set_app_default_endpoint(
        &self,
        device_id: &str,
        role: Role,
        target_pid_str: &str,
    ) -> Result<(), String> {
        let device_wide = to_wide(device_id);
        let target_wide = to_wide(target_pid_str);

        // SAFETY: vtable call. Both PCWSTR pointers are valid for the call duration.
        let hr = unsafe {
            let set_fn = (*self.vtable).SetAppDefaultAudioEndpoint;
            set_fn(
                self as *const _ as *mut core::ffi::c_void,
                PCWSTR(device_wide.as_ptr()),
                role as i32,
                PCWSTR(target_wide.as_ptr()),
            )
        };

        if hr.is_err() {
            return Err(format!("SetAppDefaultAudioEndpoint failed: 0x{:08X}", hr.0));
        }
        Ok(())
    }
}

impl Drop for IPolicyConfigVista {
    fn drop(&mut self) {
        // SAFETY: Call Release via vtable.
        unsafe {
            let release = (*self.vtable).Release;
            release(self as *const _ as *mut core::ffi::c_void);
        }
    }
}

/// Map Role to COM ERole value.
impl From<Role> for i32 {
    fn from(r: Role) -> i32 {
        match r {
            Role::Console => eConsole,
            Role::Multimedia => eMultimedia,
            Role::Communications => eCommunications,
            Role::All => eConsole,
        }
    }
}

/// Set the default audio device for a process (by PID).
///
/// This is the public entry point called by Tauri commands.
pub fn set_process_default_device(
    device_id: &str,
    pid: u32,
    role: Role,
) -> Result<(), String> {
    // SAFETY: COM init balanced with CoUninitialize.
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .map_err(|e| format!("CoInitializeEx failed: {e}"))?;
    }

    let result = (|| -> Result<(), String> {
        let policy = IPolicyConfigVista::new()?;
        let pid_str = pid.to_string();
        policy.set_app_default_endpoint(device_id, role, &pid_str)?;
        info!("routed PID {pid} to device {device_id} (role={role:?})");
        Ok(())
    })();

    // SAFETY: Balances CoInitializeEx.
    unsafe {
        CoUninitialize();
    }

    result
}

/// Convert a Rust string to a NUL-terminated wide string.
fn to_wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}
