import { motion } from 'framer-motion';
import { MAIN_THREAD_TRANSFORM, charSwapTransitions } from '@/lib/motion';
import { NAME_SLOT_PX } from './shared';

/**
 * The hub's programme name, swapping character by character when the programme
 * changes. The old word dips for a beat, then lifts away up, smaller, fainter
 * and blurring; the new word arrives from below and settles with a slight
 * overshoot — anticipation before the move, follow-through after it
 * (`charSwapTransitions` in lib/motion.ts owns the timings). Each character is
 * its own box; the slot itself is fixed (`NAME_SLOT_PX`) and clips nothing, so
 * both the blur and the travel stay whole — the slot's other occupant, the
 * arriving word, owns the layout while the departing word rides over it as an
 * absolutely positioned ghost sharing the slot's centre, so every name — long
 * or short — lives at the same fixed position and the row never moves. A
 * rapid re-selection cuts the previous ghost where it stands rather than
 * queueing it.
 *
 * The swap itself lives in the parent (`nameSwap`) — the hub card remounts on
 * every programme switch, and a swap held here would be reset by the very
 * switch it describes. Held one level up, this component may mount fresh mid-
 * swap and still play it: ghost and arrivals start from their keyframes either
 * way. `swapKey === 0` is the board's first landing, which renders in place.
 */
export function CharSwapText({
  text,
  prev,
  swapKey,
}: {
  text: string;
  prev: string | null;
  swapKey: number;
}) {
  const chars = Array.from(text);
  const prevChars = prev === null ? null : Array.from(prev);
  const first = swapKey === 0;
  return (
    <span
      className="relative inline-block h-[17px] text-[12.5px] font-bold leading-none text-text-primary"
      style={{ width: NAME_SLOT_PX }}
    >
      <span className="flex h-full items-center justify-center">
        {chars.map((ch, i) => {
          const { enter } = charSwapTransitions(i, chars.length);
          return (
            <motion.span
              key={`${swapKey}:${i}`}
              initial={first ? false : { y: 9, scale: 0.9, opacity: 0, filter: 'blur(3px)' }}
              animate={{
                y: first ? 0 : [9, -2, 0],
                scale: first ? 1 : [0.9, 1.03, 1],
                opacity: first ? 1 : [0, 1, 1],
                filter: first ? 'blur(0px)' : ['blur(3px)', 'blur(0.5px)', 'blur(0px)'],
              }}
              transition={enter}
              transformTemplate={MAIN_THREAD_TRANSFORM}
              className="inline-block whitespace-pre leading-none"
            >
              {ch}
            </motion.span>
          );
        })}
      </span>
      {prevChars !== null && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
        >
          {prevChars.map((ch, i) => {
            const { exit } = charSwapTransitions(i, prevChars.length);
            return (
              <motion.span
                key={`g:${swapKey}:${i}`}
                initial={{ y: 0, scale: 1, opacity: 1, filter: 'blur(0px)' }}
                animate={{
                  y: [0, 2.5, -11],
                  scale: [1, 0.985, 0.86],
                  opacity: [1, 0.9, 0],
                  filter: ['blur(0px)', 'blur(1.5px)', 'blur(3px)'],
                }}
                transition={exit}
                transformTemplate={MAIN_THREAD_TRANSFORM}
                className="inline-block whitespace-pre leading-none"
              >
                {ch}
              </motion.span>
            );
          })}
        </span>
      )}
    </span>
  );
}
