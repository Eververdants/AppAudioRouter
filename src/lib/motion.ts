import type { Transition } from 'framer-motion';

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

/** Opacity-only changes, where a spring would just look slow. */
export const FADE: Transition = { duration: 0.18, ease: 'easeOut' };
