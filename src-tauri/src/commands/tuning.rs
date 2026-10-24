//! The tuning axes: a device's delay, a device's share, a program's own level,
//! and a routed program's session volume.
//!
//! They are four different levers and the commands here keep them apart. A
//! **delay** holds a mirror back (or marks it the earliest of the group, which
//! lifts the others) and is bounded by `config::DELAY_MAX_MS`, the rail the
//! engine sizes its ring buffers to. A **share** is a device's fraction of the
//! loudest copy in its group and can only attenuate, because a device has a
//! hardware volume above the software one. A **source level** is a program's own
//! gain across its copies and may amplify up to `config::SOURCE_VOLUME_MAX`. A
//! **primary volume** is the program's *session* volume — the one lever that
//! reaches the primary device's loudness, floored at
//! `config::PRIMARY_VOLUME_MIN_PERCENT`, written only through
//! `DuplicationManager::update_primary_volume` and only for a routed program.
//!
//! [`align_source_levels`] balances the third against the live readings of the
//! running engines: it reads the level table and the engine's routed exe names,
//! and never enumerates sessions of its own.

use std::collections::HashSet;
use std::sync::Arc;

use log::info;
use tauri::{AppHandle, Manager, State};

use crate::audio;
use crate::audio::duplication::DuplicationManager;
use crate::audio::levels::{
    aligned_gains, audible_count, SourceLevel, SourceLevels, LEVEL_MAX_AGE,
};
use crate::config::{
    DelayConfig, PrimaryVolumeConfig, SourceVolumeConfig, VolumeConfig, SOURCE_VOLUME_MAX,
};

use super::identity::require_exe_name;
use super::AlignOutcome;

/// Set a device's delay compensation (milliseconds, signed) and push it to any
/// live engine using that device.
///
/// Positive holds the device back; negative marks it as the earliest device in
/// the group, which lifts the other mirrors instead. A magnitude beyond the
/// hard bound (`config::DELAY_MAX_MS`, the rail the engine's ring buffers are
/// sized to) is rejected.
#[tauri::command]
pub fn set_device_delay(
    device_id: String,
    delay_ms: i32,
    delays: State<'_, Arc<DelayConfig>>,
    duplications: State<'_, DuplicationManager>,
) -> Result<(), String> {
    info!("cmd: set_device_delay device={device_id} delay={delay_ms}ms");
    // The key is validated here even though a delay never reaches a COM call: it
    // is the only handle to that device's tuning, and a blank or absurd key is an
    // entry no enumeration can ever name, list back or clear. Same bound as the
    // write path and the carrier picker, so the three of them cannot disagree
    // about what a device id is.
    audio::routing::validate_device_id(&device_id).map_err(|e| e.to_string())?;
    delays.set(&device_id, delay_ms)?;
    duplications.update_delay(&device_id, delay_ms);
    Ok(())
}

/// All configured device delays as `(device_id, delay_ms)` pairs.
#[tauri::command]
pub fn get_device_delays(delays: State<'_, Arc<DelayConfig>>) -> Vec<(String, i32)> {
    delays.all()
}

/// Set a device's volume (percent, 0–100) and push it to any live engine using
/// that device as a mirror.
///
/// The value is the device's share of the loudest copy in its group: the
/// engine scales every mirror by `own / max`, so 100 leaves that device at the
/// level the app produced and smaller values attenuate it. The primary device
/// takes no share — its loudness is the program's session volume (see
/// [`set_primary_volume`]), and a value stored for the device applies whenever
/// it plays as a copy.
#[tauri::command]
pub fn set_device_volume(
    device_id: String,
    percent: u32,
    volumes: State<'_, Arc<VolumeConfig>>,
    duplications: State<'_, DuplicationManager>,
) -> Result<(), String> {
    info!("cmd: set_device_volume device={device_id} volume={percent}%");
    if percent > 100 {
        return Err("volume out of range 0-100".to_string());
    }
    // Same reason the delay key is checked: a share is stored under the device id
    // and read back by it for as long as the file lives.
    audio::routing::validate_device_id(&device_id).map_err(|e| e.to_string())?;
    volumes.set(&device_id, percent)?;
    duplications.update_volume(&device_id, percent);
    Ok(())
}

/// All configured device volumes as `(device_id, percent)` pairs.
#[tauri::command]
pub fn get_device_volumes(volumes: State<'_, Arc<VolumeConfig>>) -> Vec<(String, u32)> {
    volumes.all()
}

/// Set one program's own level (0–[`config::SOURCE_VOLUME_MAX`], where 100 is
/// that program's audio untouched) and push it to the engines already running
/// for it. Rejects out-of-range values rather than clamping, so the two sides
/// cannot end up disagreeing about what was stored.
#[tauri::command]
pub fn set_source_volume(
    exe_name: String,
    percent: u32,
    sources: State<'_, Arc<SourceVolumeConfig>>,
    duplications: State<'_, DuplicationManager>,
) -> Result<(), String> {
    info!("cmd: set_source_volume exe={exe_name} level={percent}%");
    // The key this level is stored and read under is the executable name; a blank
    // one is a level no engine will ever ask for and the settings page will still
    // list.
    require_exe_name("a program level", &exe_name)?;
    sources.set(&exe_name, percent)?;
    duplications.update_source_volume(&exe_name, percent);
    Ok(())
}

/// Every stored per-program level as `(exe_name, percent)` pairs.
#[tauri::command]
pub fn get_source_volumes(sources: State<'_, Arc<SourceVolumeConfig>>) -> Vec<(String, u32)> {
    sources.all()
}

/// Set a routed program's primary volume — its **session volume**, the value
/// the Windows volume mixer shows for it — and push it to the engines already
/// running for it.
///
/// This is the one lever that reaches the primary device's loudness: Windows
/// plays that device itself, and the loopback tap sits behind the session
/// volume, so attenuating the session attenuates the primary path. The engines
/// divide every mirror's gain by the same factor, so the copies play on
/// exactly as before and only the primary path moves. The value is floored at
/// [`config::PRIMARY_VOLUME_MIN_PERCENT`] because at 0 the capture is true
/// silence and no gain could restore the copies. Stopping the route hands the
/// program's previous loudness back.
///
/// Async, unlike the other volume commands: writing the value onto the live
/// sessions is a full device and session enumeration per engine, and a sync
/// command would run that on the WebView2 main thread — freezing the window for
/// as long as AudioSrv takes, which on a reconnecting Bluetooth endpoint is
/// seconds.
///
/// Being async costs the main thread's serialisation, so two clicks can run
/// here at once. Both halves of the write therefore take the *same* number: the
/// one the config settled on, read back inside the lock's critical section —
/// never the caller's own `percent`, which a later click may already have
/// replaced.
#[tauri::command]
pub async fn set_primary_volume(
    exe_name: String,
    percent: u32,
    app: AppHandle,
) -> Result<(), String> {
    info!("cmd: set_primary_volume exe={exe_name} volume={percent}%");
    require_exe_name("a program volume", &exe_name)?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let primaries = app.state::<Arc<PrimaryVolumeConfig>>();
        primaries.set(&exe_name, percent)?;
        // Read back, so overlapping calls converge on the last committed value
        // instead of each pushing its own: the file and the live sessions then
        // cannot land on different numbers, whichever order the two writes
        // reached the lock in. A click that a later one superseded restates the
        // settled value and changes nothing.
        let settled = primaries.get(&exe_name);
        app.state::<DuplicationManager>()
            .update_primary_volume(&exe_name, settled);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Every stored primary volume as `(exe_name, percent)` pairs.
#[tauri::command]
pub fn get_primary_volumes(primaries: State<'_, Arc<PrimaryVolumeConfig>>) -> Vec<(String, u32)> {
    primaries.all()
}

/// Bring every routed program that is playing up to the level of the loudest
/// one, in one action.
///
/// The group is whatever this app is duplicating right now rather than a list
/// handed over by the frontend: that way it cannot name a program that is not
/// routed, and a program holding several sessions cannot arrive twice under two
/// PIDs. A program with nothing playing is left exactly as it was — aligning
/// against silence would be aligning against nothing — and so is one the
/// measurement could not read.
///
/// This overwrites levels the user set by hand, which is what "align them"
/// means; the values it writes are ordinary stored levels afterwards, so they
/// can be edited from the same place as any other.
#[tauri::command]
pub fn align_source_levels(
    sources: State<'_, Arc<SourceVolumeConfig>>,
    levels: State<'_, Arc<SourceLevels>>,
    duplications: State<'_, DuplicationManager>,
) -> Result<AlignOutcome, String> {
    let routed = duplications.routed_exe_names();
    let playing: Vec<(String, SourceLevel)> = levels
        .fresh_all(LEVEL_MAX_AGE)
        .into_iter()
        .filter(|(exe_name, _)| routed.contains(exe_name))
        .collect();

    let gains = aligned_gains(&playing);
    // "Playing" means a program a listener would call playing — a live
    // reading above silence — not a program that ended up with a gain: the
    // gains only exist once two audible programs are aligned against each
    // other, and counting them would tell a user who can hear exactly one
    // program that nothing was sounding at all.
    let audible = audible_count(&playing);
    let mut applied = Vec::new();
    for (exe_name, gain) in gains {
        let percent = (gain * 100.0).round().clamp(0.0, SOURCE_VOLUME_MAX as f32) as u32;
        sources.set(&exe_name, percent)?;
        duplications.update_source_volume(&exe_name, percent);
        info!("aligned {exe_name} to {percent}%");
        applied.push((exe_name, percent));
    }

    let changed: HashSet<&str> = applied.iter().map(|(name, _)| name.as_str()).collect();
    let left_alone = routed
        .into_iter()
        .filter(|name| !changed.contains(name.as_str()))
        .collect();
    Ok(AlignOutcome {
        aligned: applied,
        left_alone,
        playing: audible,
    })
}
