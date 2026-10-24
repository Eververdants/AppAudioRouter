import {
  feederColumn,
  feederOutPort,
  hubInPort,
  hubOutPort,
  nodePath,
  rowInPort,
  rowVisible,
} from '@/lib/stage';
import type { FeedCarrier } from '@/lib/types';
import { feedLiveness } from '@/stores/routerStore';
import type { PlannedFeed } from './useFeedPlan';
import type { WireSpec } from '../shared';
import type { AudioSession } from '@/lib/types';
import type { PanelColumn } from '@/lib/stage';

/**
 * The wires of the board, in the order the plan goes out.
 *
 * A wire exists only for a row that can be met: one whose row has been scrolled
 * out of the copies panel is not drawn, and a feeder card without a seat in
 * `feederColumn`'s window is drawn neither as a card nor as a line. The seat
 * window is asked for here, once, and handed to whoever draws the cards, so the
 * two can never disagree about who is on the board.
 */
export function useBoardWires({
  height,
  column,
  copyScroll,
  primaryDeviceId,
  copyDeviceIds,
  planFeedStates,
  feeders,
  soundingFeeders,
  sounding,
  liveness,
  flowing,
  feedCarrier,
  feedTapFailures,
  hoverKey,
}: {
  height: number;
  column: PanelColumn;
  copyScroll: number;
  primaryDeviceId: string | undefined;
  copyDeviceIds: string[];
  planFeedStates: PlannedFeed[];
  feeders: AudioSession[];
  soundingFeeders: Set<string>;
  sounding: boolean;
  liveness: boolean;
  flowing: boolean;
  feedCarrier: FeedCarrier;
  feedTapFailures: Record<string, string>;
  hoverKey: string | null;
}) {
  const wires: WireSpec[] = [];
  // Hub → the primary row, then → every row of the copies panel. The hub's own
  // wires light together when it is hovered.
  const from = hubOutPort(height);
  if (primaryDeviceId !== undefined) {
    const to = rowInPort(column.primaryY, 0, 0);
    wires.push({
      key: `dev:${primaryDeviceId}`,
      d: nodePath(from.x, from.y, to.x, to.y),
      live: flowing,
    });
  }
  copyDeviceIds.forEach((deviceId, index) => {
    // A row the panel has scrolled away has no wire to meet: the row is not on
    // screen, and neither is the line that would point at it.
    if (!rowVisible(column.copiesY, column.copiesHeight, index, copyScroll)) return;
    const to = rowInPort(column.copiesY, index, copyScroll);
    wires.push({
      key: `dev:${deviceId}`,
      d: nodePath(from.x, from.y, to.x, to.y),
      live: flowing,
    });
  });
  planFeedStates.forEach(({ session: targetSession, landed, state }, offset) => {
    const index = copyDeviceIds.length + offset;
    if (!rowVisible(column.copiesY, column.copiesHeight, index, copyScroll)) return;
    const to = rowInPort(column.copiesY, index, copyScroll);
    wires.push({
      key: `feed:${targetSession.pid}`,
      d: nodePath(from.x, from.y, to.x, to.y),
      // A landed feed's wire reports the feed itself — not the state of the
      // device plan beside it. A programme whose device rows are still waiting
      // for the hub can be feeding perfectly well. A staged one is a proposal:
      // it draws itself in once, and its sound has nowhere to go until the hub
      // lands it.
      live: landed && sounding && liveness && state === 'live',
      proposed: !landed,
    });
  });
  // Feeders → hub. The column is centred on the hub and compresses only to the
  // cards' tightest pitch, so past `feedersFitting(height)` its ends leave the
  // board. The seats are what `feederColumn` hands back: a card still showing
  // half of itself keeps its seat *and* its wire — the half-cut card is the
  // "there are more of these" cue, and the wire is the only thing saying where
  // they go — while a card with nothing of itself left is drawn neither.
  const feederSeats = feederColumn(feeders.length, height);
  const feederHasSeat = (index: number): boolean =>
    index >= feederSeats.first && index < feederSeats.first + feederSeats.seated;
  feeders.forEach((feeder, index) => {
    if (!feederHasSeat(index)) return;
    const source = feederOutPort(index, feeders.length, height);
    const to = hubInPort(height);
    wires.push({
      key: `feeder:${feeder.pid}`,
      d: nodePath(source.x, source.y, to.x, to.y),
      // The same rule the feed-target wires follow on the feeder's own board:
      // this wire reports sound actually arriving here, and a feed whose
      // source is itself routed (its render slot is taken) or whose carrier is
      // not configured delivers nothing — the row reads 挂起 / 未接通, and a
      // moving wire would say the opposite of the row it hangs from.
      live:
        soundingFeeders.has(feeder.exe_name.toLowerCase()) &&
        liveness &&
        feedLiveness(feeder.exe_name, feedCarrier, feedTapFailures) === 'live',
    });
  });

  const lit = (key: string): boolean =>
    hoverKey === 'hub' && !key.startsWith('feeder:') ? true : hoverKey === key;

  return { wires, lit, feederSeats, feederHasSeat };
}
