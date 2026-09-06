/** Tauri invoke wrapper with typed commands. */

import { invoke } from '@tauri-apps/api/core';
import type { AudioDevice, AudioSession } from './types';

export async function listDevices(): Promise<AudioDevice[]> {
  return invoke<AudioDevice[]>('list_devices');
}

export async function listSessions(): Promise<AudioSession[]> {
  return invoke<AudioSession[]>('list_sessions');
}

export async function setRoute(
  deviceId: string,
  pid: number,
  role: string,
): Promise<void> {
  await invoke('set_route', { deviceId, pid, role });
}

export async function setRouteRemember(
  deviceId: string,
  pid: number,
  role: string,
  exeName: string,
): Promise<void> {
  await invoke('set_route_remember', { deviceId, pid, role, exeName });
}

export async function setDefaultDevice(
  deviceId: string,
  role: string,
): Promise<void> {
  await invoke('set_default_device', { deviceId, role });
}

export async function getRememberedRoutes(): Promise<[string, string][]> {
  return invoke<[string, string][]>('get_remembered_routes');
}

export async function clearRoute(exeName: string): Promise<void> {
  await invoke('clear_route', { exeName });
}
