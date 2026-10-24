// ---------------------------------------------------------------------------
// What the pieces of the board agree on: the card chrome, the role colours, the
// picker's curves, the wire's shape, the name slot's width, and the one key the
// bottom strip answers to.
//
// Each of these is drawn or measured in more than one file now, so each has
// exactly one home here. A second copy of the card chrome is a board whose cards
// stop matching; a second copy of the name slot's width is a name that moves the
// ring; a second kind of `InspectorKey` is a strip that tunes nothing.
// ---------------------------------------------------------------------------
import type { Variants } from 'framer-motion';
import { FADE, SPRING_GLIDE } from '@/lib/motion';

/** Which card the bottom strip is tuning right now: a destination row. The
 *  strip only exists while one is picked — there is no standing bar under the
 *  board. */
export type InspectorKey = `dev:${string}`;

/**
 * A wire drawn on the board, in the shape the SVG layer needs.
 *
 * `key` is what a hovered row lights: every wire of the hub lights together
 * when the hub is under the pointer, one wire when its own row is. The key
 * doubles as the e2e hook (`data-wire`), which the old stage's spokes already
 * answered to.
 */
export interface WireSpec {
  key: string;
  d: string;
  /** The wire moves only when sound is actually flowing through it. */
  live: boolean;
  /** Overrides the default proposal mark. A staged-but-unlanded feed draws
   *  itself in regardless of the device plan's answered-ness — it is the feed's
   *  own proposal, not the route's. */
  proposed?: boolean;
}

/** Card chrome for things that sit straight on the well: the continuous-
 *  curvature corner, the plane, and the strong hairline — flat blocks with
 *  nothing cast and nothing lifted. */
export const CARD_CLASS = 'cc absolute rounded-panel bg-surface border border-line-strong';
/** The role word colour, by role. Literal classes: Tailwind scans source text. */
export const ROLE_TEXT_CLASS = {
  primary: 'text-type-primary',
  mirror: 'text-type-mirror',
  feed: 'text-type-feed',
} as const;

/**
 * The pickers' items light up one after another as the menu opens: a stagger
 * carried by variants, opacity only — the menu's own glide brings the travel,
 * and items that never write a transform keep their `.pressable` press intact
 * (Motion and the CSS transform must never sit on one element).
 */
export const PICKER_VARIANTS: Variants = {
  closed: { opacity: 0, y: 6, scale: 0.98 },
  open: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { ...SPRING_GLIDE, staggerChildren: 0.024, delayChildren: 0.02 },
  },
};

export const PICKER_ITEM_VARIANTS: Variants = {
  closed: { opacity: 0 },
  open: { opacity: 1, transition: FADE },
};

/**
 * The name slot is a fixed stage: the words swap inside it without ever
 * moving the ring or the icon, and nothing on it may be clipped — the blur
 * and the travel spill freely, so overflow is impossible by construction.
 * Names longer than the slot are therefore capped in data, estimated per
 * character width (fullwidth ≈ 1em at 12.5px, everything else ≈ 0.55em),
 * with an ellipsis where the cut happened.
 */
export const NAME_SLOT_PX = 106;
export const NAME_BUDGET_PX = 96;

export function clampHubName(name: string): string {
  let w = 0;
  const chars = Array.from(name);
  for (let i = 0; i < chars.length; i++) {
    const code = chars[i]!.codePointAt(0) ?? 0;
    w += code > 0x2e7f ? 12.5 : 7;
    if (w > NAME_BUDGET_PX) return `${chars.slice(0, i).join('')}…`;
  }
  return name;
}
