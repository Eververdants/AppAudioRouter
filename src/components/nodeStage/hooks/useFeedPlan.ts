import { useMemo } from 'react';
import { programEntryOf } from '@/lib/routes';
import type { AudioSession, FeedCarrier } from '@/lib/types';
import { feedLiveness, findInPool } from '@/stores/routerStore';
import type { FeedLiveness } from '@/stores/routerStore';

/** One feed row of the plan: the target's session, whether the hub has landed
 *  it, and what the feed can honestly say about itself once it has. */
export type PlannedFeed = {
  session: AudioSession;
  landed: boolean;
  state: FeedLiveness;
};

/**
 * The feed half of the board's proposal, and the landed half beside it.
 *
 * The board draws the plan, not the live map — an input the user picked but has
 * not landed yet is a proposal with a row and a wire of its own, the way a
 * staged device is, and the hub is what turns it into a feed. A plan target
 * resolves through both lists, because a running app that has never opened a
 * render session is a legitimate destination and it lives in the windowed pool.
 */
export function useFeedPlan({
  pid,
  exe,
  sessions,
  windowApps,
  feeds,
  selectedFeedPids,
  feedCarrier,
  feedTapFailures,
}: {
  pid: number | undefined;
  /** The hub programme's executable: what a failure is filed under. */
  exe: string;
  sessions: AudioSession[];
  windowApps: AudioSession[];
  feeds: Record<number, number[]>;
  selectedFeedPids: number[];
  feedCarrier: FeedCarrier;
  feedTapFailures: Record<string, string>;
}) {
  // The feed plan: the programme inputs staged on this board. The board draws
  // the plan, not the live map — an input the user picked but has not landed
  // yet is a proposal with a row and a wire of its own, the way a staged
  // device is, and the hub is what turns it into a feed. A plan target
  // resolves through both lists: a running app that has never opened a render
  // session is a legitimate destination, and it lives in the windowed pool.
  const planFeedSessions = useMemo(
    () =>
      selectedFeedPids
        .map((targetPid) => findInPool(sessions, windowApps, targetPid))
        .filter((s) => s !== undefined),
    [selectedFeedPids, sessions, windowApps],
  );
  // The landed half: the program's live feeds, resolved through its holder
  // like every per-program map read here.
  const landedFeedPids = useMemo(() => {
    if (pid === undefined) return [];
    const owner = programEntryOf(sessions, feeds, pid);
    return owner === undefined ? [] : (feeds[owner] ?? []);
  }, [feeds, sessions, pid]);
  const landedFeedSet = useMemo(() => new Set(landedFeedPids), [landedFeedPids]);

  /** The board's feed rows: the plan, each with whether it has landed. A
   *  landed row speaks in the three honest states; a staged one is a proposal
   *  wearing the role word it will carry once the hub connects it. */
  const planFeedStates = planFeedSessions.map((targetSession) => ({
    session: targetSession,
    landed: landedFeedSet.has(targetSession.pid),
    state: feedLiveness(exe, feedCarrier, feedTapFailures),
  }));

  return { planFeedSessions, landedFeedPids, landedFeedSet, planFeedStates };
}
