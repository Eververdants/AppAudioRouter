//! Render device enumeration via IMMDeviceEnumerator.

use std::mem;

use log::{info, warn};
use windows::Win32::Media::Audio::{
    eRender, DEVICE_STATE_ACTIVE, IMMDevice, IMMDeviceCollection, IMMDeviceEnumerator,
};
use windows::Win32::Media::Audio::Endpoints::AUDIO_ENDPOINT_ROLE;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY;
use windows::Win32::System::Variant::PROPVARIANT;
use windows::Win32::Foundation::PWSTR;
use windows::core::GUID;

use crate::audio::AudioDevice;

// PKEY_Device_FriendlyName
const PKEY_DEVICE_FRIENDLY_NAME: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_values(0xa45c254e, 0xdf1c, 0x4efd, [0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0]),
    pid: 14,
};

/// Enumerate all active render (playback) devices.
pub fn enumerate_render_devices() -> Result<Vec<AudioDevice>, String> {
    // SAFETY: COM initialization is thread-local and balanced with CoUninitialize.
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .map_err(|e| format!("CoInitializeEx failed: {e}"))?;
    }

    let result = (|| -> Result<Vec<AudioDevice>, String> {
        // SAFETY: CLSID_MMDeviceEnumerator is a known COM CLSID.
        let enumerator: IMMDeviceEnumerator = unsafe {
            CoCreateInstance(&IMMDeviceEnumerator::IID, None, CLSCTX_ALL)
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
            let id = pwstr_to_string(&id_pwstr);
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
            let friendly: PROPVARIANT = unsafe {
                props
                    .GetValue(&PKEY_DEVICE_FRIENDLY_NAME)
                    .map_err(|e| format!("GetValue(FriendlyName) for {id} failed: {e}"))?
            };

            let name = if friendly.Anonymous.Anonymous.vt
                == windows::Win32::System::Variant::VT_LPWSTR.0 as u16
            {
                // SAFETY: We just verified the variant type.
                let pwstr_ptr = unsafe { friendly.Anonymous.Anonymous.Anonymous.pwszVal };
                pwstr_to_string(&pwstr_ptr)
            } else {
                id.clone()
            };

            unsafe {
                windows::Win32::System::Variant::PropVariantClear(&mut (&friendly as *const _ as *mut _))
                    .ok();
            }

            info!("render device: {name} [{id}]");
            devices.push(AudioDevice { id, name });
        }

        Ok(devices)
    })();

    // SAFETY: Balances CoInitializeEx at start.
    unsafe {
        CoUninitialize();
    }

    result
}

/// Convert a PWSTR (wide string pointer) to a Rust String.
fn pwstr_to_string(pwstr: &PWSTR) -> String {
    if pwstr.is_null() {
        return String::new();
    }
    // SAFETY: pwstr is a valid NUL-terminated wide string from COM.
    unsafe {
        let mut len = 0;
        let mut ptr = pwstr.0;
        while *ptr != 0 {
            len += 1;
            ptr = ptr.add(1);
        }
        let slice = std::slice::from_raw_parts(pwstr.0, len);
        String::from_utf16_lossy(slice)
    }
}
