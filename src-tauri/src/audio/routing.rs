//! Per-app default audio device routing.
//!
//! Wraps the undocumented-but-stable COM interface `IPolicyConfigVista`.
//! This is the same interface NirSoft SoundVolumeView uses for /SetAppDefault.

use log::info;
use windows::core::{GUID, HRESULT, Interface, PCWSTR};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
};

use crate::audio::Role;

// CLSID_PolicyConfigVistaClient
const CLSID_POLICY_CONFIG_VISTA: GUID = GUID::from_values(
    0x294935ce, 0xf637, 0x4e7c, [0xa4, 0x1b, 0xab, 0x25, 0x54, 0x60, 0xb8, 0x62],
);

// IPolicyConfigVista COM interface (undocumented).
//
// We define a custom Interface with the correct IID and vtable layout.
#[repr(C)]
pub struct IPolicyConfigVista {
    vtable: *const IPolicyConfigVistaVtable,
}

#[allow(non_snake_case)]
#[repr(C)]
pub struct IPolicyConfigVistaVtable {
    // IUnknown (0-2)
    QueryInterface: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        *const GUID,
        *mut *mut core::ffi::c_void,
    ) -> HRESULT,
    AddRef: unsafe extern "system" fn(*mut core::ffi::c_void) -> u32,
    Release: unsafe extern "system" fn(*mut core::ffi::c_void) -> u32,
    // IPolicyConfigVista methods (3-18)
    GetMixFormat: usize,
    GetDeviceFormat: usize,
    SetDeviceFormat: usize,
    GetProcessingPeriod: usize,
    SetProcessingPeriod: usize,
    GetSharingMode: usize,
    SetSharingMode: usize,
    GetPropertyValue: usize,
    SetPropertyValue: usize,
    SetDefaultEndpoint: usize,       // index 12
    SetEndpointVisibility: usize,     // index 13
    SetEndpointTooltip: usize,        // index 14
    SetAppDefaultAudioEndpoint: unsafe extern "system" fn(
        *mut core::ffi::c_void,
        PCWSTR,
        i32, // ERole
        PCWSTR,
    ) -> HRESULT, // index 15
    RemoveDefaultEndpoint: usize,
    RemoveAppDefaultEndpoint: usize,
    SetPersistedDefaultEndpoint: usize,
    RemovePersistedDefaultEndpoint: usize,
}

// SAFETY: IPolicyConfigVista is a valid COM interface with this IID.
unsafe impl Interface for IPolicyConfigVista {
    type Vtable = IPolicyConfigVistaVtable;
    const IID: GUID = GUID::from_u128(0xf8679f50_850a_41cf_9c72_430f290290c8);
}

impl IPolicyConfigVista {
    /// Create a new IPolicyConfigVista instance.
    pub fn new() -> Result<Self, String> {
        // SAFETY: CoCreateInstance with known CLSID and our custom Interface.
        let policy: IPolicyConfigVista = unsafe {
            CoCreateInstance(
                &CLSID_POLICY_CONFIG_VISTA,
                None,
                CLSCTX_ALL,
            )
            .map_err(|e| format!("CoCreateInstance(IPolicyConfigVista) failed: {e}"))?
        };
        Ok(policy)
    }

    /// Set the default audio endpoint for a specific process (by PID).
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
            let vtable = self.vtable();
            (vtable.SetAppDefaultAudioEndpoint)(
                self as *const _ as *mut core::ffi::c_void,
                PCWSTR(device_wide.as_ptr()),
                role.into(),
                PCWSTR(target_wide.as_ptr()),
            )
        };

        if hr.is_err() {
            return Err(format!("SetAppDefaultAudioEndpoint failed: 0x{:08X}", hr.0));
        }
        Ok(())
    }

    /// Access the vtable.
    fn vtable(&self) -> &IPolicyConfigVistaVtable {
        // SAFETY: vtable pointer is valid for a COM object.
        unsafe { &*self.vtable }
    }
}

impl Clone for IPolicyConfigVista {
    fn clone(&self) -> Self {
        // SAFETY: AddRef via vtable.
        unsafe {
            let addref = self.vtable().AddRef;
            addref(self as *const _ as *mut core::ffi::c_void);
        }
        Self { vtable: self.vtable }
    }
}

impl Drop for IPolicyConfigVista {
    fn drop(&mut self) {
        // SAFETY: Call Release via vtable.
        unsafe {
            let release = self.vtable().Release;
            release(self as *const _ as *mut core::ffi::c_void);
        }
    }
}

impl From<Role> for i32 {
    fn from(r: Role) -> i32 {
        match r {
            Role::Console => 0,
            Role::Multimedia => 1,
            Role::Communications => 2,
            Role::All => 0,
        }
    }
}

/// Set the default audio device for a process (by PID).
pub fn set_process_default_device(device_id: &str, pid: u32, role: Role) -> Result<(), String> {
    // SAFETY: COM init balanced with CoUninitialize.
    unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() {
            return Err(format!("CoInitializeEx failed: 0x{:08X}", hr.0));
        }
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
