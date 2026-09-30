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

/**
 * `(exe_name, percent)` — the level this app applies to one program's audio on
 * its way to the routed devices.
 *
 * 100 is the audio as the program produced it, and the middle of the range
 * rather than its top: below attenuates, above amplifies. Nothing here is the
 * program's own volume, and none of it is stored by Windows.
 */
export type SourceVolume = [exeName: string, percent: number];

/** What one run of the level alignment did. */
export interface AlignOutcome {
  /** Programs whose level was set, as `(exe_name, percent)`. */
  aligned: SourceVolume[];
  /** Routed programs that had nothing playing to measure, so they were left
   * exactly as they were: aligning against silence aligns against nothing. */
  leftAlone: string[];
}

/** One program's route as it stood before a route replaced it. */
export interface ReplacedRoute {
  pid: number;
  exeName: string;
  /** The devices it was routed to, in route order; null when it had no route,
   * so the way back is the system default every unrouted program plays through. */
  previous: string[] | null;
}

/**
 * What the last route replaced, so it can be put back.
 *
 * A route is a single click on the hub, and it overwrites whatever the chosen
 * programs were playing through — across several programs at once when they were
 * multi-selected. This is the memory behind the toast that offers to undo it,
 * one entry per program the route was accepted for.
 */
export interface UndoSnapshot {
  /** When the route landed; a fresh route replaces the snapshot and its own
   * timestamp is what restarts the offer's countdown. */
  at: number;
  entries: ReplacedRoute[];
}

/** A live duplication engine and its ordered route targets. */
export interface ActiveRoute {
  pid: number;
  generation: number;
  deviceIds: string[];
  /** The software-side latency each `deviceIds` entry is playing at right now,
   * in milliseconds and in the same order: the engine's pipeline depth for that
   * device plus the endpoint's own reported stream latency. `null` for the
   * primary, which Windows plays itself — there is no stream of ours there to
   * ask, and what a hardware codec or a Bluetooth link adds on top of any of
   * these is invisible from user mode. */
  latencyMs: (number | null)[];
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

/** One mirror device of a live route could not be opened, or errored out later.
 * The engine keeps serving the other devices, so this arrives on its own channel
 * instead of with the engine-level stop. */
export interface MirrorFailedEvent {
  pid: number;
  generation: number;
  deviceId: string;
  error: string;
}

/** A Core Audio change reported by the backend's notification thread: which
 * half of the lists are now stale. */
export interface AudioChangedEvent {
  devices: boolean;
  sessions: boolean;
}
