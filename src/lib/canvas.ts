import type { CSSProperties } from 'react';

/**
 * The routing canvas — what a node wears, and where its pins are.
 *
 * The routing screen is a node graph rather than a table: the program a route
 * belongs to is one node, each output device is another, and the wires between
 * them *are* the route. Blueprint is the model, and it brings one rule with it —
 * a node is painted by what it carries. Here the four states a device can be in
 * are the four colours, nothing else in the interface is allowed to be one of
 * them, and the same colour paints the port, the wire and the role word, so the
 * graph needs no legend.
 */

/**
 * What a device is currently doing for the selection.
 *
 * The first two are facts about a live route — the OS plays the primary, the
 * engine mirrors the rest. `staged` is the one that is not a fact yet: the
 * device is selected and would be routed if the user confirms. `idle` is a
 * device no route touches, which is most of them most of the time.
 */
export type NodeRole = 'primary' | 'mirror' | 'staged' | 'idle';

export function roleOf(deviceId: string, staged: string[], activeIds: string[]): NodeRole {
  const activeIndex = activeIds.indexOf(deviceId);
  if (activeIndex === 0) return 'primary';
  if (activeIndex > 0) return 'mirror';
  return staged.includes(deviceId) ? 'staged' : 'idle';
}

/**
 * Everything one role paints, as literal class names.
 *
 * Literal because Tailwind scans source text: a class assembled from a variable
 * at runtime is a class that never gets generated, which is how
 * `bg-accent-muted/50` silently came to mean nothing in this codebase.
 *
 * `glow` is the exception and is not a class at all — it names the `--*-rgb`
 * channels the bloom is composed from, because a tone-coloured shadow has to
 * differ between the light and dark palettes and eight hand-written arbitrary
 * shadow classes would drift apart from the tokens they shadow.
 */
export type RoleTone = {
  /** Outer ring of the node's port. */
  ring: string;
  /** Core of the node's port. */
  core: string;
  /** A wire that arrives at this device. */
  wire: string;
  /** The role word. */
  label: string;
  /** The node's own outline — one step louder than the shared border, but only
   *  for a device the route actually involves. */
  outline: string;
  /** The wash the card sits on. */
  wash: string;
  /** The `--*-rgb` channels the selected/hover bloom is built from. */
  glow: string;
};

export const TONE: Record<NodeRole, RoleTone> = {
  /* The device the system plays directly. Accent, because accent is already
     what marks the part of the screen that belongs to a route. */
  primary: {
    ring: 'border-type-primary',
    core: 'bg-type-primary',
    wire: 'stroke-type-primary',
    label: 'text-type-primary',
    outline: 'border-type-primary/50',
    wash: 'bg-type-primary/[0.06] dark:bg-type-primary/[0.08]',
    glow: '--type-primary-rgb',
  },
  /* A copy. The accent's neighbour hue rather than a second accent: both mean
     "this is live", and two unrelated colours would say they were unrelated. */
  mirror: {
    ring: 'border-type-mirror',
    core: 'bg-type-mirror',
    wire: 'stroke-type-mirror',
    label: 'text-type-mirror',
    outline: 'border-type-mirror/50',
    wash: 'bg-type-mirror/[0.06] dark:bg-type-mirror/[0.08]',
    glow: '--type-mirror-rgb',
  },
  /* Chosen but not applied. Amber is the colour of a question that has not been
     answered yet, and it is deliberately not a green: nothing has happened. */
  staged: {
    ring: 'border-type-staged',
    core: 'bg-type-staged',
    wire: 'stroke-type-staged',
    label: 'text-type-staged',
    outline: 'border-type-staged/50',
    wash: 'bg-type-staged/[0.07] dark:bg-type-staged/[0.09]',
    glow: '--type-staged-rgb',
  },
  /* Hardware no route touches. Stays on the shared node border: most devices are
     idle most of the time, and a board where everything is tinted is a board
     where the tint says nothing. It has no wire at all — a device the route does
     not touch is not connected to anything, and the way to draw that is to draw
     nothing, so `wire` here is only ever reached if that ever changes. */
  idle: {
    ring: 'border-type-idle',
    core: 'bg-type-idle',
    wire: 'stroke-type-idle',
    label: 'text-text-muted',
    outline: 'border-node-border',
    wash: '',
    glow: '--type-idle-rgb',
  },
};

/**
 * The bloom that says a node is part of the route.
 *
 * Inline rather than a utility class for the reason given on `RoleTone.glow`:
 * the colour has to come from the theme's channels, and the rule is one
 * property, not a shape worth naming.
 */
export function nodeBloom(tone: RoleTone, role: NodeRole): CSSProperties {
  if (role === 'idle') return {};
  return {
    boxShadow: `0 0 0 1px rgb(var(${tone.glow}) / 0.28), 0 0 26px -8px rgb(var(${tone.glow}) / 0.5)`,
  };
}

/**
 * Geometry, in CSS pixels.
 *
 * These are literals rather than `getBoundingClientRect` measurements, and the
 * components set their own widths and heights from them instead of from
 * Tailwind classes, so there is exactly one place a node's size is decided.
 * The wires are drawn from these numbers: a wire that had to wait for a
 * ResizeObserver to find its socket would arrive a frame late, and would chase
 * the node on every layout pass — which is also why the canvas has no
 * free-drag: a node whose position is measured cannot be moved by an animation
 * without leaving its wires behind.
 */
export const BOARD_PAD = 12;
export const HEAD_H = 26;
export const NODE_H = 52;
export const NODE_GAP = 10;
/** Wide enough for the name, the PID line under it, and — for a program whose
 *  route runs an engine — the level dial beside them. Also the number the
 *  board's total width is budgeted against: at the app's own default 900 px
 *  window the work area is 636 px, and source + gap + the expert device width
 *  has to stay inside it or the last column clips. */
export const SOURCE_W = 168;
/** The name cell. Fixed, like the table's was, so the role word stays next to
 *  the name it belongs to instead of drifting into the middle of the node.
 *  Wide enough for a device name plus the `· System default` suffix, which is
 *  the longest thing that cell ever says — and, with the rest of the columns,
 *  one of the numbers the board's width is budgeted from (see `SOURCE_W`). */
export const NAME_W = 192;
export const ROLE_W = 64;
export const DELAY_W = 80;
export const VOLUME_W = 56;
/** The gap the wires cross. Narrow by design — the board's whole width is
 *  budgeted (see `SOURCE_W`) — but wide enough that a fan of them still reads
 *  as a fan. */
export const COLUMN_GAP = 48;

/** Full width of a device node: what it is called, what the route does with it,
 *  and — behind the expert gate — the two values it can be tuned by. */
export function deviceWidth(advanced: boolean): number {
  return NAME_W + ROLE_W + (advanced ? DELAY_W + VOLUME_W : 0);
}

/**
 * A wire from one port to another, as a cubic Bézier.
 *
 * Both control points are horizontal so the wire leaves and arrives flat: a
 * wire that meets its port at an angle reads as a wire that missed it. The bend
 * is a little over half the gap, which keeps the curve steepest in the middle
 * where there is nothing to collide with.
 */
export function wirePath(x0: number, y0: number, x1: number, y1: number): string {
  const bend = (x1 - x0) * 0.55;
  return `M ${x0} ${y0} C ${x0 + bend} ${y0}, ${x1 - bend} ${y1}, ${x1} ${y1}`;
}

/** Where a node's port sits, given the node's top-left corner. */
export function portY(top: number): number {
  return top + NODE_H / 2;
}
