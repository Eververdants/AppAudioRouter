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

/** Set a device's delay compensation (ms); live engines pick it up instantly. */
export async function setDeviceDelay(deviceId: string, delayMs: number): Promise<void> {
  await invoke('set_device_delay', { deviceId, delayMs });
}

export async function getDelaySync(): Promise<boolean> {
  return invoke<boolean>('get_delay_sync');
}

export async function setDelaySync(enabled: boolean): Promise<void> {
  await invoke('set_delay_sync', { enabled });
}

export async function getRememberedRoutes(): Promise<RememberedRoute[]> {
  return invoke<RememberedRoute[]>('get_remembered_routes');
}

export async function clearRoute(exeName: string): Promise<void> {
  await invoke('clear_route', { exeName });
}
