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
    let props: IPropertyStore =
        match unsafe { device.OpenPropertyStore(windows::Win32::System::Com::STGM_READ) } {
            Ok(props) => props,
            // The store refusing is the same case as the name inside it refusing:
            // the endpoint is still there and still routable, so it is listed by id
            // rather than lost. `GetId` already succeeded, which is the half of the
            // information the picker and the routing commands need.
            Err(e) => {
                warn!("property store of {id} unreadable; listing it by id: {e}");
                return Ok(AudioDevice {
                    name: id.clone(),
                    id,
                });
            }
        };

    // A name the service will not hand over is not a device that cannot be
    // routed: the id is already in hand, and dropping the entry here would hide
    // a working endpoint from the list — with a live route on it, the frontend
    // would read that as the device having been unplugged. Name it by its id,
    // the same fallback a non-string value gets below.
    let name = match unsafe {
        // SAFETY: GetValue with PKEY_Device_FriendlyName returns a PROPVARIANT
        // this value owns; it is cleared when it goes out of scope at the end of
        // the arm.
        props.GetValue(&PKEY_DEVICE_FRIENDLY_NAME)
    } {
        Ok(friendly) => extract_friendly_name(&friendly, &id),
        Err(e) => {
            warn!("friendly name of {id} unreadable; listing it by id: {e}");
            id.clone()
        }
    };
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
///
/// Any answer that is not a usable string — another type, an empty or
/// whitespace-only name — falls back to `fallback`, so a device never reaches
/// the list nameless.
fn extract_friendly_name(var: &windows::core::PROPVARIANT, fallback: &str) -> String {
    // Access the inner imp type via as_raw().
    // SAFETY: Accessing union field requires unsafe.
    let inner = var.as_raw();
    let vt = unsafe { inner.Anonymous.Anonymous.vt };
    const VT_LPWSTR: u16 = 31; // VARENUM::VT_LPWSTR
    let name = if vt == VT_LPWSTR {
        // SAFETY: We verified the type; pwszVal is valid.
        let pwstr_ptr = unsafe { inner.Anonymous.Anonymous.Anonymous.pwszVal };
        crate::audio::pwstr_to_string(&windows::core::PWSTR(pwstr_ptr))
    } else {
        String::new()
    };
    usable_name(name, fallback)
}

/// Whether a name read off a device is worth showing.
///
/// A driver that answers with an empty string has not named the endpoint, and a
/// blank row in the picker is indistinguishable from the endpoint next to it —
/// which is worse than an id, because the id at least matches what the routing
/// commands and the reset path report when the same device is refused.
fn usable_name(read: String, fallback: &str) -> String {
    if read.trim().is_empty() {
        fallback.to_string()
    } else {
        read
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A name that is not a name is the case the whole fallback exists for:
    /// drivers hand back an empty string, and both halves of that — the blank
    /// value and the id that replaces it — have to reach the same list row.
    #[test]
    fn an_empty_or_blank_name_is_not_a_name() {
        assert_eq!(usable_name(String::new(), "id-1"), "id-1");
        assert_eq!(usable_name("   ".to_string(), "id-1"), "id-1");
        assert_eq!(usable_name("\t \n".to_string(), "id-1"), "id-1");
        assert_eq!(
            usable_name("Headphones".to_string(), "id-1"),
            "Headphones",
            "a real name is shown as it reads"
        );
    }

    /// A property variant that is not a string — another type, or the value
    /// missing altogether — used to be the arm that dropped the device from the
    /// list. It names it by id instead.
    #[test]
    fn a_variant_that_is_not_a_string_falls_back_to_the_id() {
        // `VT_EMPTY`, which is what a service that has no friendly name hands
        // over; the read never reaches the string arm.
        let empty = windows::core::PROPVARIANT::default();
        let id = "{0.0.0.00000000}\\{b7a1}";
        assert_eq!(extract_friendly_name(&empty, id), id);
    }
}
