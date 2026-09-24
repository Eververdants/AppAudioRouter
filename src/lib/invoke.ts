/** Tauri invoke wrapper with typed commands. */

import { invoke } from '@tauri-apps/api/core';
import type { ActiveRoute, AudioDevice, AudioSession, DeviceDelay } from './types';

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

/** Stop routing a process: halt duplication and restore the system default. */
export async function stopRoute(pid: number): Promise<void> {
  await invoke('stop_route', { pid });
}

export async function getActiveDuplications(): Promise<ActiveRoute[]> {
  return invoke<ActiveRoute[]>('get_active_duplications');
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
