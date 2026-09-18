/** Tauri invoke wrapper with typed commands. */

import { invoke } from '@tauri-apps/api/core';
import type { AudioDevice, AudioSession, DeviceDelay, RememberedRoute, Role } from './types';

export async function listDevices(): Promise<AudioDevice[]> {
  return invoke<AudioDevice[]>('list_devices');
}

export async function listSessions(): Promise<AudioSession[]> {
  return invoke<AudioSession[]>('list_sessions');
}

export async function setRoute(deviceId: string, pid: number, role: Role): Promise<void> {
  await invoke('set_route', { deviceId, pid, role });
}

export async function setDefaultDevice(deviceId: string, role: Role): Promise<void> {
  await invoke('set_default_device', { deviceId, role });
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
): Promise<void> {
  await invoke('apply_route', { pid, exeName, deviceIds, remember });
}

/** Stop routing a process: halt duplication and restore the system default. */
export async function stopRoute(pid: number): Promise<void> {
  await invoke('stop_route', { pid });
}

export async function getActiveDuplications(): Promise<number[]> {
  return invoke<number[]>('get_active_duplications');
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

export async function getRememberedRoutes(): Promise<RememberedRoute[]> {
  return invoke<RememberedRoute[]>('get_remembered_routes');
}

export async function clearRoute(exeName: string): Promise<void> {
  await invoke('clear_route', { exeName });
}
