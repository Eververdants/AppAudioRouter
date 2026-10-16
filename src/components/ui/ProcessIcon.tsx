import { motion } from 'framer-motion';
import { MAIN_THREAD_TRANSFORM, iconSwapTransitions } from '@/lib/motion';
import { useRouterStore } from '@/stores/routerStore';

/**
 * One program's executable icon.
 *
 * Sourced per executable — the icon belongs to the file, not the process — and
 * carried in the store as a data URL, fetched once and cached. Until it
 * arrives (or for good, when the file has none) the tile holds the display
 * name's first letter: a fixed slot either way, so a row never shifts when the
 * real icon lands.
 *
 * The hub passes `prev` + `swapKey` when one programme replaces another: the
 * old tile dips for a beat, then lifts away up, blurring as it goes, while the
 * new tile rises from below and settles with a slight overshoot — the same
 * physical sentence the programme's name speaks beside it, starting a hair
 * earlier so the wave begins here and travels right through the character
 * cascade. The whole tile moves, so nothing is clipped but the tile's own
 * rounded frame. Everywhere else (`swapKey` 0, the default) the tile renders
 * in place, exactly as it always has.
 */
export function ProcessIcon({
  exeName,
  name,
  size,
  prev = null,
  swapKey = 0,
}: {
  exeName: string;
  /** What the letter tile reads before the icon arrives. */
  name: string;
  size: number;
  /** The identity being replaced, when the hub swaps programmes. */
  prev?: { exeName: string; name: string } | null;
  /** Bumps with each swap; 0 renders in place. */
  swapKey?: number;
}) {
  const icon = useRouterStore((s) => s.iconByExe[exeName]);
  const prevIcon = useRouterStore((s) => (prev ? s.iconByExe[prev.exeName] : undefined));
  const letter = Array.from(name.trim())[0] ?? '?';
  const prevLetter = prev ? (Array.from(prev.name.trim())[0] ?? '?') : '';
  // Travel scales with the tile so a 16px row icon and the hub's 18px tile
  // speak with the same amplitude per pixel of frame.
  const rise = Math.max(4, Math.round(size * 0.33));
  const { enter, exit } = iconSwapTransitions();
  return (
    <span aria-hidden="true" className="relative flex-none" style={{ width: size, height: size }}>
      <motion.span
        key={swapKey}
        initial={
          swapKey === 0 ? false : { y: rise, scale: 0.92, opacity: 0, filter: 'blur(2.5px)' }
        }
        animate={{
          y: swapKey === 0 ? 0 : [rise, -rise * 0.25, 0],
          scale: swapKey === 0 ? 1 : [0.92, 1.04, 1],
          opacity: swapKey === 0 ? 1 : [0, 1, 1],
          filter: swapKey === 0 ? 'blur(0px)' : ['blur(2.5px)', 'blur(0.5px)', 'blur(0px)'],
        }}
        transition={enter}
        transformTemplate={MAIN_THREAD_TRANSFORM}
        className="absolute inset-0 flex items-center justify-center overflow-hidden rounded bg-surface-hover text-text-muted"
      >
        {icon ? (
          <img
            src={icon}
            width={size}
            height={size}
            alt=""
            draggable={false}
            className="h-full w-full"
          />
        ) : (
          <span className="text-[8px] font-semibold uppercase leading-none">{letter}</span>
        )}
      </motion.span>
      {prev !== null && swapKey > 0 && (
        <motion.span
          key={`g:${swapKey}`}
          initial={{ y: 0, scale: 1, opacity: 1, filter: 'blur(0px)' }}
          animate={{
            y: [0, size * 0.08, -rise],
            scale: [1, 0.98, 0.9],
            opacity: [1, 0.9, 0],
            filter: ['blur(0px)', 'blur(1px)', 'blur(2.5px)'],
          }}
          transition={exit}
          transformTemplate={MAIN_THREAD_TRANSFORM}
          className="absolute inset-0 flex items-center justify-center overflow-hidden rounded bg-surface-hover text-text-muted"
        >
          {prevIcon ? (
            <img
              src={prevIcon}
              width={size}
              height={size}
              alt=""
              draggable={false}
              className="h-full w-full"
            />
          ) : (
            <span className="text-[8px] font-semibold uppercase leading-none">{prevLetter}</span>
          )}
        </motion.span>
      )}
    </span>
  );
}
