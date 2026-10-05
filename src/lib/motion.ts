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

/** Visible travel: the selection pill, a view swap, a device node reaching the orbit. */
export const SPRING_GLIDE: Transition = { type: 'spring', stiffness: 380, damping: 34 };

/** The route action itself — the hub and what it sets off. */
export const SPRING_ROUTE: Transition = { type: 'spring', stiffness: 300, damping: 20 };

/**
 * Arrival: a disc leaving the hub for its place on the orbit.
 *
 * Softer than a press and slower than a glide, because travel has to be
 * followable with the eye — a disc that snaps into place reads as an error
 * being corrected, not as a thing arriving. Callers add a per-item delay from
 * their own index, so a ring of six assembles clockwise instead of blinking
 * into existence all at once.
 */
export const SPRING_ARRIVE: Transition = {
  type: 'spring',
  stiffness: 240,
  damping: 24,
  mass: 0.9,
};

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
 * the role words, the tuners, the ripple). The cost is per-frame style writes
 * for a few small layers, and only while a swap is in flight — these surfaces
 * have no standing loops.
 */
export const MAIN_THREAD_TRANSFORM: NonNullable<MotionProps['transformTemplate']> = (
  _,
  generated,
) => generated;

/**
 * A concentric ripple: one ring expanding out of the thing that just changed
 * and fading as it goes. A tween rather than a spring because a ripple is a wave
 * leaving, not a body settling — it must not overshoot or come back. One curve
 * for every ripple so a disc and the hub ripple identically.
 */
export const RIPPLE: Transition = { duration: 0.7, ease: [0.16, 1, 0.3, 1] };
