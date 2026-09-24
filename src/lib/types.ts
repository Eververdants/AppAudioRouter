/** Shared types between frontend and (conceptually) Rust backend. */

export interface AudioDevice {
  id: string;
  name: string;
}

export interface AudioSession {
  pid: number;
  exe_name: string;
  display_name: string;
}

export type Role = 'all' | 'console' | 'multimedia' | 'communications';

export interface LogEntry {
  id: number;
  timestamp: string;
  message: string;
  level: 'info' | 'success' | 'error';
}

/** `(exe_name, device_ids)` — ids in route order, first is the primary. */
export type RememberedRoute = [exeName: string, deviceIds: string[]];

/** `(device_id, delay_ms)` — signed software delay compensation for that
 * device: positive holds it back, negative makes it the earliest of its group. */
export type DeviceDelay = [deviceId: string, delayMs: number];

export type DuplicationStopReason = 'stopped' | 'process-exited' | 'error';

export interface DuplicationStoppedEvent {
  pid: number;
  generation: number;
  reason: DuplicationStopReason;
  error: string | null;
}

/** A Core Audio change reported by the backend's notification thread: which
 * half of the lists are now stale. */
export interface AudioChangedEvent {
  devices: boolean;
  sessions: boolean;
}
