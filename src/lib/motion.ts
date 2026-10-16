import type { MotionProps, Transition } from 'framer-motion';

/**
 * Every surface in the app moves on one of these four curves.
 *
 * Motion only ever reports state here — something was pressed, something
 * travelled, a route is live — and a neighbour that springs differently reads
 * as a mistake rather than as variety. Pick one of these instead of tuning a
 * fresh spring at the call site.
 */

/** Micro-interactions: a press, a hover, a badge popping in. */
export const SPRING_TAP: Transition = { type: 'spring', stiffness: 500, damping: 30 };

/** Visible travel: the selection pill, a view swap, a float panel arriving. */
export const SPRING_GLIDE: Transition = { type: 'spring', stiffness: 380, damping: 34 };

/** The route action itself — the hub and what it sets off. */
export const SPRING_ROUTE: Transition = { type: 'spring', stiffness: 300, damping: 20 };

/** Opacity-only changes, where a spring would just look slow. */
export const FADE: Transition = { duration: 0.18, ease: 'easeOut' };

/**
 * The hub's per-character name swap. The old word dips for a beat (anticipation
 * — a jumper crouches before leaving the ground), then lifts away up, smaller,
 * fainter and blurring; the new word arrives from below and settles with a
 * slight overshoot (follow-through). Both words run at once — the enter word
 * takes the layout and the exit word rides over it as a ghost. Characters
 * cascade with a small stagger; `n` caps the accumulated stagger so a long
 * name does not stretch the swap past the beat. The name slot is fixed and
 * unclipped, so the travel and the blur spill freely — nothing here may be
 * cut off by an overflow edge.
 */
const CHAR_SWAP_STAGGER_MAX = 0.016;
const CHAR_SWAP_STAGGER_BUDGET = 0.14;
const CHAR_SWAP_ENTER_LEAD = 0.05;

/** Enter/exit transitions for character `i` of `n` in a hub name swap. */
export function charSwapTransitions(i: number, n: number): { enter: Transition; exit: Transition } {
  const stagger = Math.min(CHAR_SWAP_STAGGER_MAX, CHAR_SWAP_STAGGER_BUDGET / Math.max(n - 1, 1));
  return {
    exit: { delay: i * stagger, duration: 0.24, times: [0, 0.32, 1], ease: ['easeIn', 'easeOut'] },
    enter: {
      delay: CHAR_SWAP_ENTER_LEAD + i * stagger,
      duration: 0.28,
      times: [0, 0.7, 1],
      ease: ['easeOut', 'easeInOut'],
    },
  };
}

/**
 * The hub's tile swap — the icon answering the name's per-character sentence
 * with one move of its own: a dip, then lift away up, blurring as it goes;
 * arrive from below and settle with a slight overshoot. The tile starts a
 * hair ahead of the first character, so the wave begins at the icon and
 * travels right through the cascade.
 */
const ICON_SWAP_ENTER_LEAD = 0.03;

/** Enter/exit transitions for a programme tile swapping identities. */
export function iconSwapTransitions(): { enter: Transition; exit: Transition } {
  return {
    exit: { duration: 0.22, times: [0, 0.3, 1], ease: ['easeIn', 'easeOut'] },
    enter: {
      delay: ICON_SWAP_ENTER_LEAD,
      duration: 0.26,
      times: [0, 0.7, 1],
      ease: ['easeOut', 'easeInOut'],
    },
  };
}

/**
 * Identity `transformTemplate`: opts a motion element out of Motion's WAAPI
 * path, and that is the point. When a WAAPI animation finishes, Motion cancels
 * it on the spot but commits the final value through its batched style write —
 * which lands a frame later. For that one painted frame the element falls back
 * to its stale inline base, so anything fading out blinks back at full opacity
 * exactly as it leaves; an icon swap reads as a stutter, which is how the hub
 * icon's interrupted cross-fade got reported. Main-thread animation commits
 * inline styles every frame, leaving nothing stale to fall back to.
 *
 * Put it on every element whose exit fade must not blink (the hub icon swap,
 * the role words, the tuners, the floats). The cost is per-frame style writes
 * for a few small layers, and only while a swap is in flight — these surfaces
 * have no standing loops.
 */
export const MAIN_THREAD_TRANSFORM: NonNullable<MotionProps['transformTemplate']> = (
  _,
  generated,
) => generated;
