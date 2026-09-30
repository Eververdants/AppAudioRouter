/** Tauri invoke wrapper with typed commands. */

import { invoke } from '@tauri-apps/api/core';
import type {
  ActiveRoute,
  AlignOutcome,
  AudioDevice,
  AudioSession,
  DeviceDelay,
  RememberedRoute,
  ResetOutcome,
  SourceVolume,
  StartupNotice,
  StopOutcome,
} from './types';

export async function listDevices(): Promise<AudioDevice[]> {
  return invoke<AudioDevice[]>('list_devices');
}

export async function listSessions(): Promise<AudioSession[]> {
  return invoke<AudioSession[]>('list_sessions');
}

export async function getDefaultDevice(): Promise<AudioDevice> {
  return invoke<AudioDevice>('get_default_device');
}

/** Route a process to an ordered device list; first id is the primary. */
export async function applyRoute(
  pid: number,
  exeName: string,
  deviceIds: string[],
  remember: boolean,
): Promise<number> {
  return invoke<number>('apply_route', { pid, exeName, deviceIds, remember });
}

/** Stop routing a process: halt duplication and hand it back to the system
 * default device. The outcome says whether the program's fixed output device
 * could be released, because one left in place would keep the program on the
 * old device no matter what the user picks afterwards. */
export async function stopRoute(pid: number): Promise<StopOutcome> {
  return invoke<StopOutcome>('stop_route', { pid });
}

/** Release the fixed output device of every program no live route is using.
 * The way out for programs an earlier version left pinned. */
export async function resetPinnedEndpoints(): Promise<ResetOutcome> {
  return invoke<ResetOutcome>('reset_pinned_endpoints');
}

/** Release assignments whose program exited while it was routed. Returns the
 * executable names that were released. */
export async function releaseStaleRoutes(): Promise<string[]> {
  return invoke<string[]>('release_stale_routes');
}

export async function getActiveDuplications(): Promise<ActiveRoute[]> {
  return invoke<ActiveRoute[]>('get_active_duplications');
}

/** Every remembered route as `(exe_name, device_ids)`, ids in route order. */
export async function getRememberedRoutes(): Promise<RememberedRoute[]> {
  return invoke<RememberedRoute[]>('get_remembered_routes');
}

/** Forget one executable's remembered route. */
export async function clearRoute(exeName: string): Promise<void> {
  await invoke('clear_route', { exeName });
}

export async function getDeviceDelays(): Promise<DeviceDelay[]> {
  return invoke<DeviceDelay[]>('get_device_delays');
}

/** Set a device's delay compensation (ms, signed); live engines pick it up
 * instantly. Rejected when the magnitude exceeds the configured range. */
export async function setDeviceDelay(deviceId: string, delayMs: number): Promise<void> {
  await invoke('set_device_delay', { deviceId, delayMs });
}

/** Largest magnitude a delay may be set to, in milliseconds. */
export async function getDelayRange(): Promise<number> {
  return invoke<number>('get_delay_range');
}

/** Set the delay range; values outside the new bound are clamped and applied. */
export async function setDelayRange(rangeMs: number): Promise<void> {
  await invoke('set_delay_range', { rangeMs });
}

export async function getDelaySync(): Promise<boolean> {
  return invoke<boolean>('get_delay_sync');
}

export async function setDelaySync(enabled: boolean): Promise<void> {
  await invoke('set_delay_sync', { enabled });
}

/** Set a device's volume (percent, 0–100), live engines pick it up instantly. */
export async function setDeviceVolume(deviceId: string, percent: number): Promise<void> {
  await invoke('set_device_volume', { deviceId, percent });
}

/** All configured device volumes as `(device_id, percent)` pairs. */
export async function getDeviceVolumes(): Promise<[string, number][]> {
  return invoke<[string, number][]>('get_device_volumes');
}

/** All stored per-program levels as `(exe_name, percent)` pairs. */
export async function getSourceVolumes(): Promise<SourceVolume[]> {
  return invoke<SourceVolume[]>('get_source_volumes');
}

/** Set one program's own level (percent, 0–400, where 100 leaves the audio as
 * the program produced it). Rejected when the value is out of range. */
export async function setSourceVolume(exeName: string, percent: number): Promise<void> {
  await invoke('set_source_volume', { exeName, percent });
}

/** Bring every routed program that is playing up to the loudest one's level, in
 * one action, and report which programs that covered and which it left alone. */
export async function alignSourceLevels(): Promise<AlignOutcome> {
  return invoke<AlignOutcome>('align_source_levels');
}

/** Whether the close button hides the window to the tray instead of quitting. */
export async function getCloseToTray(): Promise<boolean> {
  return invoke<boolean>('get_close_to_tray');
}

export async function setCloseToTray(enabled: boolean): Promise<void> {
  await invoke('set_close_to_tray', { enabled });
}

/** Whether the app is registered to start when the user signs in. */
export async function getAutostart(): Promise<boolean> {
  return invoke<boolean>('get_autostart');
}

export async function setAutostart(enabled: boolean): Promise<void> {
  await invoke('set_autostart', { enabled });
}

/** True when Windows launched this instance at sign-in, so no window should show. */
export async function isSilentLaunch(): Promise<boolean> {
  return invoke<boolean>('is_silent_launch');
}

/** Localize the native tray menu, which cannot reach the frontend's i18n itself. */
export async function setTrayLabels(show: string, quit: string): Promise<void> {
  await invoke('set_tray_labels', { show, quit });
}

/** What this install should be told about itself: a first run, or an update
 * whose earlier version may have left per-app endpoint assignments behind. */
export async function getStartupNotice(): Promise<StartupNotice | null> {
  return invoke<StartupNotice | null>('get_startup_notice');
}

/** Record that this version has run, so the notice is not shown again. */
export async function ackStartupNotice(): Promise<void> {
  await invoke('ack_startup_notice');
}
