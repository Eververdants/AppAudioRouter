/** Shared types between frontend and (conceptually) Rust backend. */

export interface AudioDevice {
  id: string;
  name: string;
}

export interface AudioSession {
  pid: number;
  exe_name: string;
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

/** What the window should say about this install on launch. */
export interface StartupNotice {
  /** A fresh install, or an earlier version that may have left assignments. */
  kind: 'first-run' | 'upgrade';
  /** Version that ran here last, when the install recorded one. */
  previous_version: string | null;
}

/** One executable's remembered route, as the store keeps it. */
export interface RememberedRouteEntry {
  /** Executable name, exactly as the backend stored it. */
  exeName: string;
  /** Targets in route order; the first is the primary endpoint. */
  deviceIds: string[];
}

/** `(device_id, delay_ms)` — signed software delay compensation for that
 * device: positive holds it back, negative makes it the earliest of its group. */
export type DeviceDelay = [deviceId: string, delayMs: number];

/** A live duplication engine and its ordered route targets. */
export interface ActiveRoute {
  pid: number;
  generation: number;
  deviceIds: string[];
}

export type DuplicationStopReason = 'stopped' | 'process-exited' | 'error';

export interface DuplicationStoppedEvent {
  pid: number;
  generation: number;
  reason: DuplicationStopReason;
  error: string | null;
}

/** What `stop_route` left behind.
 *
 * `released` is false when the program is still fixed to an endpoint: Windows
 * applies that fixed endpoint before the system default, so the program ignores
 * later device switches until the assignment is cleared. */
export interface StopOutcome {
  released: boolean;
  /** Endpoint the program is still pinned to; `null` when it was unreadable. */
  pinned_device: string | null;
}

/** Result of clearing the per-app output assignments no live route uses. */
export interface ResetOutcome {
  /** Programs whose fixed output device was released. */
  released: number;
  /** Executable names the audio service would not let go. */
  still_pinned: string[];
}

/** A Core Audio change reported by the backend's notification thread: which
 * half of the lists are now stale. */
export interface AudioChangedEvent {
  devices: boolean;
  sessions: boolean;
}
