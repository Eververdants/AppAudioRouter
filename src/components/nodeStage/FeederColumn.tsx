import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { ProcessIcon } from '@/components/ui/ProcessIcon';
import { Ring } from '@/components/ui/Ring';
import { MAIN_THREAD_TRANSFORM, SPRING_TAP } from '@/lib/motion';
import { FEEDER_X, MINI_H, MINI_W, feederY } from '@/lib/stage';
import type { AudioSession } from '@/lib/types';
import type { FeederColumn as FeederSeats } from '@/lib/stage';
import { CARD_CLASS } from './shared';

/**
 * The programmes sending sound into the hub, as the column of cards down the
 * board's left edge, plus the two soft edges that say the column goes on.
 *
 * The cards and their wires are cut by ONE window — the `feederSeats` the board
 * asked `lib/stage.ts` for — and the seat test is handed in with it, so a card
 * can never be drawn for a wire that is not, or the other way round.
 */
export function FeederColumn({
  feeders,
  feederSeats,
  feederHasSeat,
  height,
  name,
  soundingFeeders,
  liveness,
  setHoverKey,
  selectProcess,
}: {
  feeders: AudioSession[];
  /** The seat window this column was cut with: the wires use the same one. */
  feederSeats: FeederSeats;
  /** Whether the card at `index` has a seat on the board. */
  feederHasSeat: (index: number) => boolean;
  height: number;
  /** The hub programme's name: every feeder says whose input it is. */
  name: string | undefined;
  /** Which of these feeders are sounding, by executable name. */
  soundingFeeders: Set<string>;
  liveness: boolean;
  setHoverKey: (key: string | null) => void;
  selectProcess: (pid: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {/* Feeders: the programmes sending sound into the hub. A click walks
              to that programme's own board — the graph answers one programme at
              a time, and this is the door between them. */}
      {feeders.map((feeder, index) => {
        // The well clips vertically and never scrolls, so a card the board
        // cannot show by half is one nobody can aim at or reach with the
        // keyboard — and a focusable button nobody can see is not on the
        // board. The seated half-cards are the column's end, and the fading
        // edge below says the column goes on.
        if (!feederHasSeat(index)) return null;
        const feederName = feeder.display_name ?? feeder.exe_name;
        const feederSounding = soundingFeeders.has(feeder.exe_name.toLowerCase());
        return (
          <motion.button
            key={feeder.pid}
            type="button"
            // A source taking its seat: it grows out of the edge its wire
            // leaves from, so the pin stays put and the line never chases.
            initial={{ opacity: 0, scaleX: 0.94 }}
            animate={{ opacity: 1, scaleX: 1 }}
            transition={SPRING_TAP}
            transformTemplate={MAIN_THREAD_TRANSFORM}
            onMouseEnter={() => setHoverKey(`feeder:${feeder.pid}`)}
            onMouseLeave={() => setHoverKey(null)}
            onClick={() => selectProcess(feeder.pid)}
            aria-label={t('stage.feederAria', { process: feederName, target: name ?? '' })}
            title={t('stage.feederTitle', { target: name ?? '' })}
            className={`${CARD_CLASS} flex flex-col items-start justify-center gap-1 px-3 text-left hover:border-line-strong focus-visible:border-accent focus-visible:outline-none`}
            style={{
              left: FEEDER_X,
              top: feederY(index, feeders.length, height),
              width: MINI_W,
              height: MINI_H,
              transformOrigin: 'right center',
            }}
          >
            <span className="pin pin-out" aria-hidden="true" />
            <span className="flex w-full items-center gap-2">
              <Ring tone="idle" size={12} live={feederSounding && liveness} />
              <ProcessIcon exeName={feeder.exe_name} name={feederName} size={16} />
              <span className="truncate text-[11.5px] font-semibold text-text-primary">
                {feederName}
              </span>
            </span>
            <span className="w-full truncate pl-[22px] text-xs text-text-muted">
              {t('stage.feederSub', { target: name ?? '' })}
            </span>
          </motion.button>
        );
      })}

      {/* The cut edges of the feeders' column: the same soft edge the copies
              panel paints, and for the same reason — a card that ends mid-height
              has to read as the column going on, not as a card that failed to
              render. The well's own background closing over the cards, so it is
              a gradient of one colour into nothing, never a mask. It paints
              nothing while every card has its seat. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-0 h-4 bg-gradient-to-b from-surface-sunken to-transparent transition-opacity duration-200"
        style={{ left: FEEDER_X, width: MINI_W, opacity: feederSeats.cutAbove ? 1 : 0 }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 h-6 bg-gradient-to-t from-surface-sunken to-transparent transition-opacity duration-200"
        style={{ left: FEEDER_X, width: MINI_W, opacity: feederSeats.cutBelow ? 1 : 0 }}
      />
    </>
  );
}
