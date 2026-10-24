import type {
  DuplicationReadyEvent,
  DuplicationStoppedEvent,
  FeedTapFailedEvent,
  MirrorFailedEvent,
  SessionActivityEvent,
} from '@/lib/types';

/** The backend's own events folded into the store, and the one pass that
 *  re-reads which engines are alive. Nothing here is a poll: every handler is
 *  an event, and every handler that changes an engine's life reconciles. */
export interface EngineActions {
  handleDuplicationStopped: (event: DuplicationStoppedEvent) => void;
  /** One process began or stopped rendering audio. Display state for the
   * routing board; the routing logic never reads it. */
  handleSessionActivity: (event: SessionActivityEvent) => void;
  /** An engine has finished opening its mirror devices, so the latency it can
   *  report now exists. Re-reads it; there is no other moment to. */
  handleDuplicationReady: (event: DuplicationReadyEvent) => void;
  /** One mirror of a live route went quiet. The rest of the route keeps playing,
   * so only that device leaves the badge set — and the log says which one and why. */
  handleMirrorFailed: (event: MirrorFailedEvent) => void;
  /** The tap carrying a program's feed stopped working. The program's own
   *  devices are unaffected, so nothing leaves a route; the program's feed rows
   *  turn from 送入 into 挂起 and the failure is said out loud. */
  handleFeedTapFailed: (event: FeedTapFailedEvent) => void;
  /** Ask the backend which PIDs it is still duplicating — routes survive a
   *  restart — and reconcile the badges and the per-device latency readings with
   *  it. Runs at boot, and once whenever a route appears, so a fresh route needs
   *  no Core Audio change to be measured. */
  reconcileActiveDuplications: () => Promise<void>;
}
