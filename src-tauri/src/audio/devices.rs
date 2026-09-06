//! Render device enumeration via IMMDeviceEnumerator.

use log::info;
use windows::Win32::Media::Audio::{
    eRender, DEVICE_STATE_ACTIVE, IMMDevice, IMMDeviceCollection, IMMDeviceEnumerator,
    MMDeviceEnumerator,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, PROPERTYKEY};

use crate::audio::AudioDevice;

// PKEY_Device_FriendlyName
const PKEY_DEVICE_FRIENDLY_NAME: PROPERTYKEY = PROPERTYKEY {
    fmtid: windows::core::GUID::from_values(
        0xa45c254e, 0xdf1c, 0x4efd, [0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0],
    ),
    pid: 14,
};

/// Enumerate all active render (playback) devices.
pub fn enumerate_render_devices() -> Result<Vec<AudioDevice>, String> {
    let com_owned = crate::audio::init_com()?;

    let result = (|| -> Result<Vec<AudioDevice>, String> {
        // SAFETY: MMDeviceEnumerator is the registered coclass for IMMDeviceEnumerator.
        let enumerator: IMMDeviceEnumerator = unsafe {
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| format!("CoCreateInstance(IMMDeviceEnumerator) failed: {e}"))?
        };

        // SAFETY: eRender + DEVICE_STATE_ACTIVE are valid params.
        let collection: IMMDeviceCollection = unsafe {
            enumerator
                .EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)
                .map_err(|e| format!("EnumAudioEndpoints failed: {e}"))?
        };

        let count = unsafe { collection.GetCount().map_err(|e| format!("GetCount failed: {e}"))? };

        let mut devices = Vec::with_capacity(count as usize);

        for i in 0..count {
            // SAFETY: i is within [0, count).
            let device: IMMDevice = unsafe {
                collection
                    .Item(i)
                    .map_err(|e| format!("Item({i}) failed: {e}"))?
            };

            // SAFETY: GetId returns a PWSTR we must free with CoTaskMemFree.
            let id_pwstr = unsafe {
                device.GetId().map_err(|e| format!("GetId({i}) failed: {e}"))?
            };
            let id = pwstr_to_string(id_pwstr.as_ptr());
            unsafe {
                windows::Win32::System::Com::CoTaskMemFree(Some(id_pwstr.as_ptr() as *const _));
            }

            // SAFETY: OpenPropertyStore with STGM_READ is valid.
            let props: IPropertyStore = unsafe {
                device
                    .OpenPropertyStore(windows::Win32::System::Com::STGM_READ)
                    .map_err(|e| format!("OpenPropertyStore({id}) failed: {e}"))?
            };

            // SAFETY: GetValue with PKEY_Device_FriendlyName returns a PROPVARIANT.
            let friendly = unsafe {
                props
                    .GetValue(&PKEY_DEVICE_FRIENDLY_NAME)
                    .map_err(|e| format!("GetValue(FriendlyName) for {id} failed: {e}"))?
            };

            // Extract the string from the PROPVARIANT.
            // friendly is windows_core::PROPVARIANT which has Drop impl (auto-clears).
            let name = extract_friendly_name(&friendly, &id);

            info!("render device: {name} [{id}]");
            devices.push(AudioDevice { id, name });
        }

        Ok(devices)
    })();

    crate::audio::uninit_com(com_owned);

    result
}

/// Extract the friendly name string from a PROPVARIANT.
fn extract_friendly_name(var: &windows::core::PROPVARIANT, fallback: &str) -> String {
    // Access the inner imp type via as_raw().
    // SAFETY: Accessing union field requires unsafe.
    let inner = var.as_raw();
    let vt = unsafe { inner.Anonymous.Anonymous.vt };
    const VT_LPWSTR: u16 = 31; // VARENUM::VT_LPWSTR
    if vt == VT_LPWSTR {
        // SAFETY: We verified the type; pwszVal is valid.
        let pwstr_ptr = unsafe { inner.Anonymous.Anonymous.Anonymous.pwszVal };
        pwstr_to_string(pwstr_ptr)
    } else {
        fallback.to_string()
    }
}

/// Convert a PWSTR (wide string pointer) to a Rust String.
fn pwstr_to_string(pwstr: *const u16) -> String {
    if pwstr.is_null() {
        return String::new();
    }
    // SAFETY: pwstr is a valid NUL-terminated wide string from COM.
    unsafe {
        let mut len = 0;
        let mut ptr = pwstr;
        while *ptr != 0 {
            len += 1;
            ptr = ptr.add(1);
        }
        let slice = std::slice::from_raw_parts(pwstr, len);
        String::from_utf16_lossy(slice)
    }
}
