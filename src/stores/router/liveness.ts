import type { FeedCarrier } from '@/lib/types';

/** One executable's remembered feed rules: the programs its audio feeds into. */
export interface RememberedFeedEntry {
  sourceExe: string;
  targetExe: string[];
}

/** Where a feed rule stands right now.
 *
 * `live`: the carrier is configured and the engine is playing the programme's
 * audio into its playback side, so the target records the programme while the
 * programme itself keeps playing wherever it plays — a feed is a second
 * destination, never a move. `no-carrier`: no endpoint pair is configured, so
 * the rule is recorded but nothing can move. `suspended`: the carrier is
 * configured, but the tap that carries the audio is not running any more (the
 * endpoint went away, or the engine refused to open it); setting the feed again
 * is what puts the wire back. */
export type FeedLiveness = 'live' | 'suspended' | 'no-carrier';

export function feedLiveness(
  sourceExe: string,
  carrier: FeedCarrier,
  tapFailures: Record<string, string>,
): FeedLiveness {
  if (carrier.render === null || carrier.capture === null) return 'no-carrier';
  if (sourceExe !== '' && tapFailures[sourceExe.toLowerCase()] !== undefined) return 'suspended';
  return 'live';
}
