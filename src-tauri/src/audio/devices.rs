//! Render device enumeration via IMMDeviceEnumerator.

use log::{info, warn};
use windows::Win32::Media::Audio::{
    eCapture, eConsole, eRender, IMMDevice, IMMDeviceCollection, IMMDeviceEnumerator,
    MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, PROPERTYKEY};

use crate::audio::AudioDevice;
use crate::audio::AudioError;

// PKEY_Device_FriendlyName
const PKEY_DEVICE_FRIENDLY_NAME: PROPERTYKEY = PROPERTYKEY {
    fmtid: windows::core::GUID::from_values(
        0xa45c254e,
        0xdf1c,
        0x4efd,
        [0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0],
    ),
    pid: 14,
};

/// Enumerate all active render (playback) devices.
pub fn enumerate_render_devices() -> Result<Vec<AudioDevice>, AudioError> {
    enumerate_devices_of_flow(eRender, "render")
}

/// Enumerate all active capture (recording) devices.
///
/// The other half of a feed: the carrier pair's capture side is where the
/// target program records from, so the settings picker has to be able to list
/// these alongside the playback endpoints.
pub fn enumerate_capture_devices() -> Result<Vec<AudioDevice>, AudioError> {
    enumerate_devices_of_flow(eCapture, "capture")
}

/// The shared walk, told which half of the audio graph to enumerate.
fn enumerate_devices_of_flow(
    flow: windows::Win32::Media::Audio::EDataFlow,
    label: &str,
) -> Result<Vec<AudioDevice>, AudioError> {
    let com_owned = crate::audio::init_com()?;

    let result = (|| -> Result<Vec<AudioDevice>, AudioError> {
        // SAFETY: MMDeviceEnumerator is the registered coclass for IMMDeviceEnumerator.
        let enumerator: IMMDeviceEnumerator = unsafe {
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| {
                AudioError::Api(format!("CoCreateInstance(IMMDeviceEnumerator) failed: {e}"))
            })?
        };

        // SAFETY: flow + DEVICE_STATE_ACTIVE are valid params.
        let collection: IMMDeviceCollection = unsafe {
            enumerator
                .EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE)
                .map_err(|e| AudioError::Api(format!("EnumAudioEndpoints({label}) failed: {e}")))?
        };

        let count = unsafe {
            collection
                .GetCount()
                .map_err(|e| AudioError::Api(format!("GetCount failed: {e}")))?
        };

        let mut devices = Vec::with_capacity(count as usize);

        for i in 0..count {
            // SAFETY: i is within [0, count).
            let device: IMMDevice = match unsafe { collection.Item(i) } {
                Ok(device) => device,
                // A device vanishing between GetCount and its Item call — a
                // hotplug race — is the same skip-able failure a device that
                // will not open is below, not a reason the whole list is lost.
                Err(e) => {
                    warn!("skipping {label} device {i}: Item failed: {e}");
                    continue;
                }
            };

            // One endpoint that will not open — a driver in a bad state, an
            // endpoint that denies its property store — must not take the rest
            // of the list with it: "every device but that one" is usable, "no
            // devices at all" leaves the user with nothing to route to.
            match device_info(&device) {
                Ok(device) => {
                    info!("{label} device: {} [{}]", device.name, device.id);
                    devices.push(device);
                }
                Err(e) => warn!("skipping {label} device {i}: {e}"),
            }
        }

        Ok(devices)
    })();

    crate::audio::uninit_com(com_owned);

    result
}

/// Read the endpoint id and friendly name of one device.
fn device_info(device: &IMMDevice) -> Result<AudioDevice, AudioError> {
    // SAFETY: GetId returns a PWSTR we must free with CoTaskMemFree.
    let id_pwstr = unsafe {
        device
            .GetId()
            .map_err(|e| AudioError::Api(format!("GetId failed: {e}")))?
    };
    let id = crate::audio::pwstr_to_string(&id_pwstr);
    unsafe {
        windows::Win32::System::Com::CoTaskMemFree(Some(id_pwstr.as_ptr() as *const _));
    }

    // SAFETY: OpenPropertyStore with STGM_READ is valid.
    let props: IPropertyStore = unsafe {
        device
            .OpenPropertyStore(windows::Win32::System::Com::STGM_READ)
            .map_err(|e| AudioError::Api(format!("OpenPropertyStore({id}) failed: {e}")))?
    };

    // SAFETY: GetValue with PKEY_Device_FriendlyName returns a PROPVARIANT.
    let friendly = unsafe {
        props
            .GetValue(&PKEY_DEVICE_FRIENDLY_NAME)
            .map_err(|e| AudioError::Api(format!("GetValue(FriendlyName) for {id} failed: {e}")))?
    };

    // Extract the string from the PROPVARIANT.
    let name = extract_friendly_name(&friendly, &id);
    Ok(AudioDevice { id, name })
}

/// Get the current system default render device.
pub fn get_default_render_device() -> Result<AudioDevice, AudioError> {
    let com_owned = crate::audio::init_com()?;

    let result = (|| -> Result<AudioDevice, AudioError> {
        // SAFETY: MMDeviceEnumerator is the registered coclass.
        let enumerator: IMMDeviceEnumerator = unsafe {
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| {
                AudioError::Api(format!("CoCreateInstance(IMMDeviceEnumerator) failed: {e}"))
            })?
        };

        // SAFETY: eRender + eConsole are valid flow/role values.
        let device: IMMDevice = unsafe {
            enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(|e| AudioError::Api(format!("GetDefaultAudioEndpoint failed: {e}")))?
        };

        device_info(&device)
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
        crate::audio::pwstr_to_string(&windows::core::PWSTR(pwstr_ptr))
    } else {
        fallback.to_string()
    }
}
