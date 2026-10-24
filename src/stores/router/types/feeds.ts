import type { FeedCarrier } from '@/lib/types';
import type { RememberedFeedEntry } from '../liveness';

/** The live feed map, its memory, and the carrier that makes delivery possible. */
export interface FeedsState {
  /**
   * Live feed targets keyed by source PID, in the order they were added.
   * Rebuilt from the memory and the live session list on every session refresh:
   * a feed needs both processes present, so a process leaving the list takes its
   * half of the wire with it.
   */
  feeds: Record<number, number[]>;
  /**
   * "Send into" rules the backend remembers, one entry per source executable.
   * A rule is recorded even when it cannot be delivered yet — the node on the
   * board stays visible and says what is missing instead of vanishing.
   */
  rememberedFeeds: RememberedFeedEntry[];
  /**
   * The endpoint pair that carries feeds (a loopback driver's render + capture
   * sides, configured in settings). Either half null means feeds are recorded
   * but nothing can move.
   */
  feedCarrier: FeedCarrier;
  /**
   * Programs whose feed tap died after it was set, keyed by executable name
   * (lower case) with the backend's own words as the value. A tap is a stream of
   * ours into the carrier, so it can fail like any other stream — and unlike a
   * route's device it has no row of its own to go quiet. Cleared for a program
   * the next time one of its feeds is delivered again.
   */
  feedTapFailures: Record<string, string>;
}

/** The inputs a feed needs (memory, carrier) and the two verbs that land one. */
export interface FeedsActions {
  /** Read the remembered feed rules and rebuild the live feed map from them. */
  loadFeeds: () => Promise<void>;
  /** Read the configured carrier pair (both halves may be null). */
  loadFeedCarrier: () => Promise<void>;
  /** Point the carrier at a new endpoint pair; pending feeds try to deliver. */
  setFeedCarrier: (render: string | null, capture: string | null) => Promise<void>;
  /** Land one feed rule: record it in the memory, pin the endpoints the carrier
   *  can carry, and log the pair's honest outcome. The landing primitive the
   *  hub's apply drives for every planned feed — never called on a pick. */
  addFeed: (sourcePid: number, targetPid: number) => Promise<void>;
  /** Take one landed feed rule down: unrecord it, release the target's side,
   *  and leave the source's own output untouched. */
  removeFeed: (sourcePid: number, targetPid: number) => Promise<void>;
  /** Put every remembered feed whose two ends are live back on. Like the
   * device-route restore, it waits for the lists and the memory; whichever of
   * the three lands last calls it. */
  restoreRememberedFeeds: () => Promise<void>;
}
