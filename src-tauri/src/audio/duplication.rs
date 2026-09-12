//! Multi-device audio duplication ("route one app to several devices").
//!
//! Windows assigns exactly one default endpoint per app, so routing an app to
//! N > 1 devices is built from two channels:
//!
//! 1. Primary — device #1 becomes the app's persisted default endpoint via
//!    `AudioPolicyConfig` (see `routing.rs`); its audio flows there natively.
//! 2. Mirrors — every further device receives a software copy of the app's
//!    audio, produced here: a WASAPI *process loopback* capture taps the
//!    process's mixed output, and one event-driven render client per mirror
//!    device writes the same frames into that device.
//!
//! The tap uses `ActivateAudioInterfaceAsync` with
//! `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` (Windows 10 build 20348+).
//! Capture and mirror devices may run different mix formats: both sides
//! initialize with `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM` and
//! `AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY`, so WASAPI converts between the
//! shared capture format and each device's engine format. No virtual-audio
//! driver is involved, which keeps the project free of third-party executables.
//!
//! Lifecycle: [`DuplicationManager`] (Tauri state) owns one engine per PID.
//! Each engine is a capture thread plus one render thread per mirror. Threads
//! watch a shared `shutdown` flag and, when it is set — or when the target
//! process exits — they clean up, unregister the engine, and notify the
//! frontend via the `duplication-stopped` event.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use log::{info, warn};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use windows::core::{implement, IUnknown, Interface, HRESULT, PCWSTR, PROPVARIANT};
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::Media::Audio::{
    eConsole, eRender, ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
    IAudioCaptureClient, IAudioClient, IAudioRenderClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK,
    AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, AUDIOCLIENT_ACTIVATION_PARAMS,
    AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
    VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX,
};
use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemAlloc, CoTaskMemFree, CLSCTX_ALL};
use windows::Win32::System::Threading::{
    CreateEventW, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
};

use crate::audio::AudioError;

/// Shared-mode stream buffer, in hundreds of nanoseconds (200 ms).
const STREAM_BUFFER_DURATION: i64 = 2_000_000;
/// Render threads poll the shutdown flag at this interval when idle.
const RENDER_WAIT_MS: u32 = 250;
/// Capture thread polls process liveness at this interval when silent.
const CAPTURE_WAIT_MS: u32 = 2_000;
/// Upper bound for the asynchronous process-loopback activation.
const ACTIVATION_TIMEOUT: Duration = Duration::from_secs(5);

/// Generations handed out to engines so a stale thread can never unregister a
/// newer engine that replaced it for the same PID.
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Why an engine's capture thread exited.
enum ExitReason {
    /// The shutdown flag was set (user stopped the route or re-routed).
    Stopped,
    /// The target process no longer exists.
    ProcessExited,
    /// A Windows API call failed.
    Error(AudioError),
}

impl ExitReason {
    fn event_name(&self) -> &'static str {
        match self {
            ExitReason::Stopped => "stopped",
            ExitReason::ProcessExited => "process-exited",
            ExitReason::Error(_) => "error",
        }
    }

    fn error_message(&self) -> Option<String> {
        match self {
            ExitReason::Error(e) => Some(e.to_string()),
            _ => None,
        }
    }
}

/// One mirror device with its frame ring buffer.
struct MirrorChannel {
    device_id: String,
    /// Raw capture-format bytes, always a whole number of frames.
    ring: Mutex<VecDeque<u8>>,
    /// Ring capacity in bytes (about 500 ms of the capture format).
    capacity: usize,
    /// Cleared when the device fails to open or errors out; pushes and pops
    /// become no-ops so the remaining mirrors keep playing.
    enabled: AtomicBool,
}

impl MirrorChannel {
    /// Enqueue one capture chunk, trimming the ring when device clocks drift
    /// apart. Drops whole frames only, so the ring stays frame-aligned.
    fn push(&self, chunk: &[u8], block_align: usize) {
        if !self.enabled.load(Ordering::Relaxed) {
            return;
        }
        let mut ring = self.ring.lock().unwrap_or_else(|e| e.into_inner());
        ring.extend(chunk);
        let excess = ring.len().saturating_sub(self.capacity);
        if excess > 0 {
            let aligned = excess - excess % block_align;
            ring.drain(..aligned);
        }
    }

    /// Take at most `max_frames` frames of audio for one render cycle.
    fn pop(&self, max_frames: usize, block_align: usize) -> Vec<u8> {
        if max_frames == 0 || !self.enabled.load(Ordering::Relaxed) {
            return Vec::new();
        }
        let mut ring = self.ring.lock().unwrap_or_else(|e| e.into_inner());
        let take = ring.len().min(max_frames * block_align);
        let aligned = take - take % block_align;
        ring.drain(..aligned).collect()
    }
}

/// Immutable state shared by one engine's threads.
struct EngineShared {
    pid: u32,
    generation: u64,
    shutdown: AtomicBool,
    mirrors: Vec<Arc<MirrorChannel>>,
    /// Raw bytes of the capture format (WAVEFORMATEX, possibly extensible).
    format: Vec<u8>,
    /// Bytes per frame of the capture format.
    block_align: usize,
}

/// Per-process duplication engines, managed as Tauri state.
#[derive(Default)]
pub struct DuplicationManager {
    engines: Mutex<HashMap<u32, Arc<EngineShared>>>,
}

impl DuplicationManager {
    /// Create the manager.
    pub fn new() -> Self {
        Self::default()
    }

    /// Start duplicating `pid`'s audio to `mirror_device_ids`, replacing any
    /// engine already running for the process.
    ///
    /// The capture format is probed synchronously (a fast call); the
    /// process-loopback activation runs on the engine thread and reports
    /// failures through the `duplication-stopped` event with reason `error`.
    pub fn start(
        &self,
        pid: u32,
        mirror_device_ids: Vec<String>,
        app: &AppHandle,
    ) -> Result<(), AudioError> {
        self.stop(pid);
        if mirror_device_ids.is_empty() {
            return Ok(());
        }
        if pid == 0 {
            return Err(AudioError::Api("invalid pid".to_string()));
        }

        let (format, block_align, sample_rate) = default_mix_format()?;
        let ring_capacity = sample_rate as usize * block_align / 2;
        let mirrors = mirror_device_ids
            .into_iter()
            .map(|device_id| {
                Arc::new(MirrorChannel {
                    device_id,
                    ring: Mutex::new(VecDeque::new()),
                    capacity: ring_capacity,
                    enabled: AtomicBool::new(true),
                })
            })
            .collect();

        let shared = Arc::new(EngineShared {
            pid,
            generation: NEXT_GENERATION.fetch_add(1, Ordering::Relaxed),
            shutdown: AtomicBool::new(false),
            mirrors,
            format,
            block_align,
        });
        self.engines
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(pid, shared.clone());

        let app = app.clone();
        std::thread::Builder::new()
            .name(format!("aar-dup-{pid}"))
            .spawn(move || capture_main(shared, app))
            .map_err(|e| AudioError::Api(format!("spawn capture thread failed: {e}")))?;
        Ok(())
    }

    /// Signal the engine for `pid` to stop. Threads clean up asynchronously.
    pub fn stop(&self, pid: u32) {
        if let Some(shared) = self
            .engines
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&pid)
        {
            shared.shutdown.store(true, Ordering::Relaxed);
        }
    }

    /// PIDs with a live engine.
    pub fn active_pids(&self) -> Vec<u32> {
        self.engines
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .keys()
            .copied()
            .collect()
    }

    /// Remove `pid`'s engine unless a newer engine replaced it. Called by the
    /// engine's own capture thread on exit.
    fn unregister(&self, pid: u32, generation: u64) {
        let mut engines = self.engines.lock().unwrap_or_else(|e| e.into_inner());
        if engines.get(&pid).map(|e| e.generation) == Some(generation) {
            engines.remove(&pid);
        }
    }
}

/// Entry point of an engine's capture thread.
fn capture_main(shared: Arc<EngineShared>, app: AppHandle) {
    let reason = run_capture(&shared);
    // Release the render threads regardless of how the capture loop ended.
    shared.shutdown.store(true, Ordering::Relaxed);
    match &reason {
        ExitReason::Stopped => info!(
            "duplication for PID {} stopped ({} mirrors)",
            shared.pid,
            shared.mirrors.len()
        ),
        ExitReason::ProcessExited => {
            info!("duplication for PID {} ended: process exited", shared.pid)
        }
        ExitReason::Error(e) => warn!("duplication for PID {} failed: {e}", shared.pid),
    }
    app.state::<DuplicationManager>()
        .unregister(shared.pid, shared.generation);
    let _ = app.emit(
        "duplication-stopped",
        json!({
            "pid": shared.pid,
            "reason": reason.event_name(),
            "error": reason.error_message(),
        }),
    );
}

/// Activate the capture client and pump captured frames into the mirror rings.
fn run_capture(shared: &Arc<EngineShared>) -> ExitReason {
    let com_owned = match crate::audio::init_com() {
        Ok(owned) => owned,
        Err(e) => return ExitReason::Error(e),
    };
    let result = capture_loop(shared);
    crate::audio::uninit_com(com_owned);
    result
}

fn capture_loop(shared: &Arc<EngineShared>) -> ExitReason {
    match capture_stream(shared) {
        Ok(reason) => reason,
        Err(e) => ExitReason::Error(e),
    }
}

fn capture_stream(shared: &Arc<EngineShared>) -> Result<ExitReason, AudioError> {
    let com_err =
        |what: &str, e: windows::core::Error| AudioError::Api(format!("{what} failed: {e}"));
    let client = activate_process_loopback(shared.pid)?;
    if shared.shutdown.load(Ordering::Relaxed) {
        return Ok(ExitReason::Stopped);
    }

    let event = unsafe {
        // SAFETY: no security attributes, unnamed auto-reset event; closed at
        // the end of this function after the audio client is released.
        CreateEventW(None, false, false, None).map_err(|e| com_err("CreateEventW", e))?
    };
    // SAFETY: format is a complete WAVEFORMATEX(EXTENSIBLE) copied from the
    // default device's mix format.
    let format = unsafe { &*(shared.format.as_ptr() as *const WAVEFORMATEX) };
    // SAFETY: shared-mode event-driven process loopback; periodicity must be 0
    // in shared mode. AUTOCONVERTPCM lets the requested format differ from the
    // engine mix; if loopback capture rejects the conversion path, retry with
    // the plain mix format.
    unsafe {
        client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK
                    | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                    | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                    | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                STREAM_BUFFER_DURATION,
                0,
                format,
                None,
            )
            .or_else(|_| {
                client.Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                    STREAM_BUFFER_DURATION,
                    0,
                    format,
                    None,
                )
            })
            .map_err(|e| com_err("Initialize(capture)", e))?;
    }
    // SAFETY: valid handle; the client is event-driven so the handle must stay
    // valid for the lifetime of the stream. Must come after Initialize.
    if let Err(e) = unsafe { client.SetEventHandle(event) } {
        return Err(com_err("SetEventHandle", e));
    }
    // SAFETY: GetService on a fully initialized capture client.
    let capture: IAudioCaptureClient = unsafe {
        client
            .GetService()
            .map_err(|e| com_err("GetService(IAudioCaptureClient)", e))?
    };
    // SAFETY: Start on a fully initialized capture client.
    if let Err(e) = unsafe { client.Start() } {
        return Err(com_err("Start(capture)", e));
    }

    let mut render_threads = Vec::with_capacity(shared.mirrors.len());
    for mirror in &shared.mirrors {
        let mirror = mirror.clone();
        let shared = shared.clone();
        // Render threads report their own errors via `enabled`, so the join
        // result is ignored on purpose.
        render_threads.push(std::thread::spawn(move || render_main(shared, mirror)));
    }

    let reason = capture_packets(shared, &capture, event);
    // SAFETY: Stop on a started client; errors during shutdown are ignored.
    unsafe {
        let _ = client.Stop();
    }
    for handle in render_threads {
        let _ = handle.join();
    }
    // SAFETY: the capture client has been stopped and released by now.
    unsafe {
        let _ = CloseHandle(event);
    }
    Ok(reason)
}

/// Drain capture packets until shutdown, error, or process exit.
fn capture_packets(
    shared: &Arc<EngineShared>,
    capture: &IAudioCaptureClient,
    event: HANDLE,
) -> ExitReason {
    match capture_packets_inner(shared, capture, event) {
        Ok(reason) => reason,
        Err(e) => ExitReason::Error(e),
    }
}

fn capture_packets_inner(
    shared: &Arc<EngineShared>,
    capture: &IAudioCaptureClient,
    event: HANDLE,
) -> Result<ExitReason, AudioError> {
    let com_err =
        |what: &str, e: windows::core::Error| AudioError::Api(format!("{what} failed: {e}"));
    loop {
        // SAFETY: valid event handle owned by this thread.
        let wait = unsafe { WaitForSingleObject(event, CAPTURE_WAIT_MS) };
        if shared.shutdown.load(Ordering::Relaxed) {
            return Ok(ExitReason::Stopped);
        }
        if wait == WAIT_TIMEOUT {
            // The loopback event only fires while the process actually plays
            // audio; use idle timeouts to notice process exit.
            if !process_alive(shared.pid) {
                return Ok(ExitReason::ProcessExited);
            }
            continue;
        }

        loop {
            // SAFETY: packet query on a started capture client.
            let packet = unsafe {
                capture
                    .GetNextPacketSize()
                    .map_err(|e| com_err("GetNextPacketSize", e))?
            };
            if packet == 0 {
                break;
            }
            let mut data: *mut u8 = std::ptr::null_mut();
            let mut frames = 0u32;
            let mut flags = 0u32;
            // SAFETY: out params; the buffer is valid until ReleaseBuffer.
            if let Err(e) =
                unsafe { capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None) }
            {
                return Err(com_err("GetBuffer(capture)", e));
            }
            if frames > 0 && flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 == 0 {
                let bytes = frames as usize * shared.block_align;
                // SAFETY: GetBuffer guarantees `bytes` writable bytes.
                let chunk = unsafe { std::slice::from_raw_parts(data, bytes) };
                for mirror in &shared.mirrors {
                    mirror.push(chunk, shared.block_align);
                }
            }
            // SAFETY: balances GetBuffer with the number of frames read.
            if let Err(e) = unsafe { capture.ReleaseBuffer(frames) } {
                return Err(com_err("ReleaseBuffer(capture)", e));
            }
        }
    }
}

/// Entry point of one mirror's render thread.
fn render_main(shared: Arc<EngineShared>, mirror: Arc<MirrorChannel>) {
    if let Err(e) = render_loop(&shared, &mirror) {
        warn!("mirror device {} failed: {e}", mirror.device_id);
        mirror.enabled.store(false, Ordering::Relaxed);
    }
}

fn render_loop(shared: &EngineShared, mirror: &MirrorChannel) -> Result<(), AudioError> {
    let com_owned = crate::audio::init_com()?;
    let result = render_packets(shared, mirror);
    crate::audio::uninit_com(com_owned);
    result
}

fn render_packets(shared: &EngineShared, mirror: &MirrorChannel) -> Result<(), AudioError> {
    let com_err =
        |what: &str, e: windows::core::Error| AudioError::Api(format!("{what} failed: {e}"));
    let device_id = mirror.device_id.clone();
    let enumerator: IMMDeviceEnumerator = unsafe {
        // SAFETY: MMDeviceEnumerator is the registered coclass.
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .map_err(|e| com_err("CoCreateInstance", e))?
    };
    let wide: Vec<u16> = device_id.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: wide is NUL-terminated and outlives the call.
    let device = unsafe {
        enumerator
            .GetDevice(PCWSTR(wide.as_ptr()))
            .map_err(|e| com_err("GetDevice", e))?
    };
    // SAFETY: activating IAudioClient on an active render device.
    let client: IAudioClient = unsafe {
        device
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| com_err("Activate(IAudioClient)", e))?
    };
    let event = unsafe {
        // SAFETY: unnamed auto-reset event, closed at the end of this function.
        CreateEventW(None, false, false, None).map_err(|e| com_err("CreateEventW", e))?
    };
    let render = render_stream(shared, mirror, &client, event);
    // SAFETY: the render client is stopped/released before the event closes.
    unsafe {
        let _ = CloseHandle(event);
    }
    render
}

fn render_stream(
    shared: &EngineShared,
    mirror: &MirrorChannel,
    client: &IAudioClient,
    event: HANDLE,
) -> Result<(), AudioError> {
    let com_err =
        |what: &str, e: windows::core::Error| AudioError::Api(format!("{what} failed: {e}"));
    // SAFETY: format is a complete WAVEFORMATEX(EXTENSIBLE) copied from the
    // default device's mix format; auto-convert adapts it to this device.
    let format = unsafe { &*(shared.format.as_ptr() as *const WAVEFORMATEX) };
    // SAFETY: shared-mode event-driven render; periodicity must be 0.
    unsafe {
        client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                    | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                    | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                STREAM_BUFFER_DURATION,
                0,
                format,
                None,
            )
            .map_err(|e| com_err("Initialize(render)", e))?;
        client
            .SetEventHandle(event)
            .map_err(|e| com_err("SetEventHandle(render)", e))?;
    }
    let render: IAudioRenderClient = unsafe {
        client
            .GetService()
            .map_err(|e| com_err("GetService(IAudioRenderClient)", e))?
    };
    // SAFETY: GetBufferSize on an initialized client; frames are in units of
    // the requested (capture) format, matching the ring buffers.
    let buffer_frames = unsafe {
        client
            .GetBufferSize()
            .map_err(|e| com_err("GetBufferSize", e))?
    } as usize;
    // SAFETY: Start on a fully initialized render client.
    unsafe {
        client.Start().map_err(|e| com_err("Start(render)", e))?;
    }

    let result = pump_render(shared, mirror, client, &render, event, buffer_frames);
    // SAFETY: Stop on a started client; errors during shutdown are ignored.
    unsafe {
        let _ = client.Stop();
    }
    result
}

/// Event-driven render cycle: keep the device buffer filled from the ring,
/// writing silence whenever the captured stream has nothing (yet).
#[allow(clippy::too_many_arguments)]
fn pump_render(
    shared: &EngineShared,
    mirror: &MirrorChannel,
    client: &IAudioClient,
    render: &IAudioRenderClient,
    event: HANDLE,
    buffer_frames: usize,
) -> Result<(), AudioError> {
    let com_err =
        |what: &str, e: windows::core::Error| AudioError::Api(format!("{what} failed: {e}"));
    loop {
        // SAFETY: valid event handle owned by this thread.
        let wait = unsafe { WaitForSingleObject(event, RENDER_WAIT_MS) };
        if shared.shutdown.load(Ordering::Relaxed) {
            return Ok(());
        }
        if wait == WAIT_TIMEOUT {
            continue;
        }
        // SAFETY: padding query on a started render client.
        let padding = unsafe {
            client
                .GetCurrentPadding()
                .map_err(|e| com_err("GetCurrentPadding", e))?
        } as usize;
        let free = buffer_frames.saturating_sub(padding);
        if free == 0 {
            continue;
        }
        let chunk = mirror.pop(free, shared.block_align);
        if chunk.is_empty() {
            // SAFETY: silent frames need no data access; the buffer is valid
            // until ReleaseBuffer.
            unsafe {
                render
                    .GetBuffer(free as u32)
                    .map_err(|e| com_err("GetBuffer(render)", e))?;
                render
                    .ReleaseBuffer(free as u32, AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)
                    .map_err(|e| com_err("ReleaseBuffer(render)", e))?;
            }
        } else {
            let frames = (chunk.len() / shared.block_align) as u32;
            // SAFETY: copy of exactly frames * block_align bytes into the
            // buffer returned by GetBuffer.
            unsafe {
                let dst = render
                    .GetBuffer(frames)
                    .map_err(|e| com_err("GetBuffer(render)", e))?;
                std::ptr::copy_nonoverlapping(chunk.as_ptr(), dst, chunk.len());
                render
                    .ReleaseBuffer(frames, 0)
                    .map_err(|e| com_err("ReleaseBuffer(render)", e))?;
            }
        }
    }
}

/// Activate an `IAudioClient` that captures everything `pid` plays.
fn activate_process_loopback(pid: u32) -> Result<IAudioClient, AudioError> {
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

/// Copy the default render device's mix format.
///
/// Returns `(raw format bytes, bytes per frame, samples per second)`. The
/// engine's shared-mode format is the natural capture format for process
/// loopback, and mirrors let WASAPI auto-convert it to their own mix format.
fn default_mix_format() -> Result<(Vec<u8>, usize, u32), AudioError> {
    let com_owned = crate::audio::init_com()?;
    let result = (|| -> Result<(Vec<u8>, usize, u32), AudioError> {
        let enumerator: IMMDeviceEnumerator = unsafe {
            // SAFETY: MMDeviceEnumerator is the registered coclass.
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|e| AudioError::Api(format!("CoCreateInstance failed: {e}")))?
        };
        let device = unsafe {
            // SAFETY: eRender + eConsole are valid flow/role values.
            enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(|e| AudioError::Api(format!("GetDefaultAudioEndpoint failed: {e}")))?
        };
        // SAFETY: activating IAudioClient on an active render device.
        let client: IAudioClient = unsafe {
            device
                .Activate(CLSCTX_ALL, None)
                .map_err(|e| AudioError::Api(format!("Activate(IAudioClient) failed: {e}")))?
        };
        let wfx = unsafe {
            // SAFETY: GetMixFormat returns an owned allocation freed below.
            client
                .GetMixFormat()
                .map_err(|e| AudioError::Api(format!("GetMixFormat failed: {e}")))?
        };
        let (bytes, block_align, sample_rate) = unsafe {
            // SAFETY: wfx is a valid format struct of `total` bytes.
            let fmt = &*wfx;
            let total = core::mem::size_of::<WAVEFORMATEX>() + fmt.cbSize as usize;
            let bytes = core::slice::from_raw_parts(wfx.cast::<u8>(), total).to_vec();
            (bytes, fmt.nBlockAlign as usize, fmt.nSamplesPerSec)
        };
        // SAFETY: balances GetMixFormat's allocation.
        unsafe {
            CoTaskMemFree(Some(wfx.cast::<core::ffi::c_void>()));
        }
        Ok((bytes, block_align, sample_rate))
    })();
    crate::audio::uninit_com(com_owned);
    result
}

/// Returns true while `pid` still refers to a live process.
fn process_alive(pid: u32) -> bool {
    // SAFETY: OpenProcess with QUERY_LIMITED_INFORMATION; handle closed below.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) };
    match handle {
        Ok(h) => {
            // SAFETY: h is a valid handle; WAIT_OBJECT_0 means terminated.
            let exited = unsafe { WaitForSingleObject(h, 0) } == WAIT_OBJECT_0;
            // SAFETY: balances OpenProcess.
            unsafe {
                let _ = CloseHandle(h);
            }
            !exited
        }
        // The process was openable when the route was applied, so an
        // OpenProcess failure now means it is gone.
        Err(_) => false,
    }
}
