import type { ResetOutcome, UndoSnapshot } from '@/lib/types';

/** What is routed right now, per holding process, and the identity of the
 *  engine each route runs on. */
export interface RoutingState {
  /** Devices each process is currently routed to, keyed by PID. */
  routedPids: Record<number, string[]>;
  /** True while a route request is in flight, so a rapid double-click cannot
   * dispatch two overlapping routes against the same selection. */
  applying: boolean;
  /** Generation counter per PID, incremented on each applyRoute/stopRoute so a
   * stale duplication-stopped event from a previous engine cannot clear the
   * state of a newer one. */
  engineGenerations: Record<number, number>;
  /** What the last route replaced, while the offer to put it back still stands.
   * Null when there is nothing to undo (nothing routed yet, or it was used,
   * waved away, or overtaken by a stop). */
  undoSnapshot: UndoSnapshot | null;
}

/** Landing a plan: the single-PID seam and the one press that drives it. */
export interface RouteApplyActions {
  /** Route one program to `deviceIds` and resolve with the generation of the
   * engine the backend started for it; rejects when the backend refused. The
   * single-PID seam the routing paths share — what a route means to the rest of
   * the state is written by the caller, which is the only side that knows
   * whether it is routing one program or a batch. */
  routeOne: (
    pid: number,
    exeName: string,
    deviceIds: string[],
    /** Whether the backend also writes this route to the memory. */
    remember: boolean,
  ) => Promise<number>;
  applyRoute: () => Promise<void>;
}

/** Taking routes back down: the undo offer and the two stop paths. */
export interface RouteStopActions {
  /** Put back what the last route replaced: every program it took over returns
   * to the devices it was on, or to the system default when it was on none.
   * Consumes the offer, so it can only be run once. */
  undoLastRoute: () => Promise<void>;
  /** Drop the offer without acting on it (the toast timed out, Escape was
   * pressed, a new route replaced it, or the route was stopped by hand). */
  dismissUndo: () => void;
  stopRoute: (pid: number) => Promise<void>;
  stopAllRoutes: () => Promise<void>;
}

/** The wider releases: the per-app assignments this app no longer holds a route
 *  for, and the wipe the tour offers. */
export interface RouteResetActions {
  /** Release the fixed output device of every program no live route is using.
   * The way out for programs an earlier version of this app left pinned. The
   * outcome is returned so the launch notice can report what it cleared. */
  resetPinnedEndpoints: () => Promise<ResetOutcome | null>;
  /** The tour's "start clean": take down what the boot restore already put up,
   *  then forget the predecessor's memory and tuning. Rejects when the files
   *  could not be forgotten — the tour is the only place this is offered and it
   *  never returns to offer it twice, so an unfinished wipe has to be said out
   *  loud rather than watched past. */
  startClean: () => Promise<void>;
  /** Release assignments whose program exited while it was routed, so its next
   * launch follows the system default again instead of the old device. */
  releaseStaleRoutes: () => Promise<void>;
}

export type RoutingActions = RouteApplyActions & RouteStopActions & RouteResetActions;
