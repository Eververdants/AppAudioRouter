//! The asynchronous process-loopback activation.
//!
//! `ActivateAudioInterfaceAsync` with
//! `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` is the only way to tap one
//! process's mixed output, and it answers on a completion handler Windows calls
//! wherever it likes. [`ActivateSignal`] is the completion flag and the bounded
//! wait ([`ACTIVATION_TIMEOUT`]); [`ActivateHandler`] does nothing but wake it, and
//! the waiter reads the outcome from the operation object itself.
//!
//! The `IAudioClient` this returns belongs to the thread that asked, and is never
//! handed to another one (see [`super::capture`]).

use std::sync::{Arc, Condvar, Mutex};

use windows::core::{implement, IUnknown, Interface, HRESULT, PROPVARIANT};
use windows::Win32::Media::Audio::{
    ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
    IAudioClient, AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
};
use windows::Win32::System::Com::CoTaskMemAlloc;

use crate::audio::AudioError;

use super::ACTIVATION_TIMEOUT;

/// Activate an `IAudioClient` that captures everything `pid` plays.
pub(super) fn activate_process_loopback(pid: u32) -> Result<IAudioClient, AudioError> {
    let com_owned = crate::audio::init_com()?;
    let result = activate_process_loopback_inner(pid);
    crate::audio::uninit_com(com_owned);
    result
}

fn activate_process_loopback_inner(pid: u32) -> Result<IAudioClient, AudioError> {
    let params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
                TargetProcessId: pid,
            },
        },
    };

    // Wrap the params in a VT_BLOB PROPVARIANT, as the activation API expects.
    // The blob is allocated with CoTaskMemAlloc; the managed PROPVARIANT's
    // Drop runs PropVariantClear, which frees it — so it must NOT be freed
    // manually anywhere in this function.
    let activation_params = unsafe {
        // SAFETY: zeroed PROPVARIANT is a valid empty variant.
        let mut raw: windows::core::imp::PROPVARIANT = core::mem::zeroed();
        // SAFETY: params is a plain-C struct; reading its bytes is valid.
        let bytes = core::slice::from_raw_parts(
            (&params as *const AUDIOCLIENT_ACTIVATION_PARAMS).cast::<u8>(),
            core::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>(),
        );
        // SAFETY: allocation ownership moves into the PROPVARIANT, whose Drop
        // (PropVariantClear) releases it.
        let buf = CoTaskMemAlloc(bytes.len());
        if buf.is_null() {
            return Err(AudioError::Api("CoTaskMemAlloc failed".to_string()));
        }
        // SAFETY: buf holds at least bytes.len() writable bytes.
        core::ptr::copy_nonoverlapping(bytes.as_ptr(), buf.cast::<u8>(), bytes.len());
        // 65 = VT_BLOB; windows-core's imp VARENUM is a plain u16 alias.
        raw.Anonymous.Anonymous.vt = 65u16;
        raw.Anonymous.Anonymous.Anonymous.blob = windows::core::imp::BLOB {
            cbSize: bytes.len() as u32,
            pBlobData: buf.cast::<u8>(),
        };
        // SAFETY: raw is fully initialized above and ownership moves on.
        PROPVARIANT::from_raw(raw)
    };

    let signal = Arc::new(ActivateSignal::default());
    let handler: IActivateAudioInterfaceCompletionHandler = ActivateHandler {
        signal: signal.clone(),
    }
    .into();
    // SAFETY: registered virtual device id, valid IID, blob payload kept alive
    // until after the wait, and handler alive until the callback fires.
    let operation: IActivateAudioInterfaceAsyncOperation = unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&activation_params),
            &handler,
        )
        .map_err(|e| AudioError::Api(format!("ActivateAudioInterfaceAsync failed: {e}")))?
    };

    let (done_lock, notify) = (&signal.done, &signal.notify);
    let done = done_lock.lock().unwrap_or_else(|e| e.into_inner());
    if !*done {
        // Keep the guard alive for the whole wait; it drops with the tuple.
        let (_guard, timeout) = notify
            .wait_timeout_while(done, ACTIVATION_TIMEOUT, |finished| !*finished)
            .unwrap_or_else(|e| e.into_inner());
        if timeout.timed_out() {
            return Err(AudioError::Api(
                "process loopback activation timed out".to_string(),
            ));
        }
    }

    let mut hr = HRESULT(0);
    let mut unk: Option<IUnknown> = None;
    // SAFETY: valid out params on a completed activation operation.
    unsafe {
        operation
            .GetActivateResult(&mut hr, &mut unk)
            .map_err(|e| AudioError::Api(format!("GetActivateResult failed: {e}")))?;
    }
    if hr.is_err() {
        return Err(AudioError::Api(format!(
            "process loopback activation failed: 0x{:08X}",
            hr.0
        )));
    }
    let unk = unk.ok_or_else(|| AudioError::Api("activation returned no interface".to_string()))?;
    unk.cast::<IAudioClient>()
        .map_err(|e| AudioError::Api(format!("activated interface is not IAudioClient: {e}")))
}

/// Completion flag shared between the activation callback and the waiter.
#[derive(Default)]
struct ActivateSignal {
    done: Mutex<bool>,
    notify: Condvar,
}

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct ActivateHandler {
    signal: Arc<ActivateSignal>,
}

// Implemented on the macro-generated wrapper (`Deref`s to `ActivateHandler`),
// which is what the vtable shim requires in windows 0.58.
impl IActivateAudioInterfaceCompletionHandler_Impl for ActivateHandler_Impl {
    fn ActivateCompleted(
        &self,
        _activateoperation: Option<&IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        // The waiter reads the outcome from the operation object itself; the
        // callback only wakes it.
        let mut done = self.signal.done.lock().unwrap_or_else(|e| e.into_inner());
        *done = true;
        self.signal.notify.notify_all();
        Ok(())
    }
}
