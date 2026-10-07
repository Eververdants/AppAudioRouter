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
