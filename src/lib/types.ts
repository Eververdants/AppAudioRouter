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

/** `(device_id, delay_ms)` — software delay compensation for that device. */
export type DeviceDelay = [deviceId: string, delayMs: number];

export type DuplicationStopReason = 'stopped' | 'process-exited' | 'error';

export interface DuplicationStoppedEvent {
  pid: number;
  reason: DuplicationStopReason;
  error: string | null;
}
