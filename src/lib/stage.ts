import type { CSSProperties } from 'react';

/**
 * The concentric stage — the one place a route is drawn.
 *
 * Everything about the shape of the routing screen is arithmetic, and it all
 * answers from here. The subject (the program being routed) sits at the centre;
 * every output device is a disc on a ring around it; a spoke from the hub to a
 * lit disc *is* the route, exactly as a wire between two nodes was.
 *
 * Why it is this shape and not a table's worth of columns: the question this
 * screen answers is "where is this program's sound going", and a ring answers
 * it with position — the lit discs are the answer, and the eye does not have to
 * read four headings first to know what column it is looking at. It also scales
 * the way the feature does: one program to five devices is a star, and it reads
 * as one shape rather than as five rows that happen to share a colour.
 *
 * Why there is no dragging, no pan and no zoom: every position is derived from
 * the route order, so the spokes are computed rather than measured. A
 * `getBoundingClientRect` here would put every spoke one frame behind every
 * spring, and it buys nothing — six discs fit at a glance, so there is nothing
 * to go looking for.
 */

/** What a device is doing for the subject right now. */
export type StageRole = 'primary' | 'mirror' | 'idle';

/**
 * The role of one device.
 *
 * The first two are positions in this program's route: Windows plays the first
 * device itself, and every device after it is a copy this app mirrors. `idle`
 * is hardware no route touches, which is most devices most of the time.
 */
export function roleOf(deviceId: string, routeIds: string[]): StageRole {
  const index = routeIds.indexOf(deviceId);
  if (index === 0) return 'primary';
  if (index > 0) return 'mirror';
  return 'idle';
}

/**
 * Size of the ring, in CSS pixels.
 *
 * Literals rather than measurements, and the components take their sizes from
 * these instead of from Tailwind classes, for the one reason that mattered on
 * the board before it and still does: a spoke drawn from `getBoundingClientRect`
 * arrives a frame late and then chases every layout pass. Fixed numbers mean the
 * disc and the spoke that meets it cannot disagree. 620 × 460 is what the work
 * area measures at the app's own default 900 px window; it scrolls below that,
 * it never squashes.
 */
export const STAGE_W = 620;
export const STAGE_H = 460;

/** The programme at the centre: its name, and whether it is sounding. */
export const HUB_D = 120;
/** One output device. The size is also what decides the orbit's radius: two
 *  neighbouring discs have to clear each other plus the room the label under
 *  them takes, which at ten devices is the tightest the ring ever gets. */
export const DISC_D = 76;
/** Distance from the stage's centre to the centre of a disc. Chosen so the
 *  spoke from the hub's rim to a disc's rim is long enough to read as a
 *  connection rather than as a tick mark: at 162 it is ~64 px against a hub of
 *  120 and a disc of 76. */
export const ORBIT_R = 162;

/** The centre of the stage, in the same coordinates everything above uses. */
export function stageCentre(): { cx: number; cy: number } {
  return { cx: STAGE_W / 2, cy: STAGE_H / 2 };
}

/**
 * The dashed ring that sits just outside the hub.
 *
 * Furniture until a route exists, at which point it takes the route's colour —
 * the stage saying "something is attached here" without drawing another line.
 * It is also what keeps the middle of the stage from reading as one more
 * button: hub, halo, orbit are three circles sharing a centre, and that is the
 * shape the whole interface is made of.
 */
export const HUB_HALO_R = HUB_D / 2 + 16;

/**
 * Where a disc begins, before it travels to its place on the orbit.
 *
 * A disc does not fade in where it stands: it comes out of the hub along its
 * own bearing, which is the only thing on this stage that explains where discs
 * come from. The fraction is how far back toward the centre it starts — far
 * enough to read as travel, near enough that it never looks like a fly-in from
 * off screen.
 */
export function approach(index: number, count: number): { x: number; y: number } {
  const { x, y } = satellite(index, count);
  const { cx, cy } = stageCentre();
  return { x: (cx - x) * 0.34, y: (cy - y) * 0.34 };
}

/**
 * Where one disc sits.
 *
 * Evenly spaced from twelve o'clock and clockwise, so the ring has a fixed
 * starting point to read from: with an even count the first device sits at the
 * top rather than somewhere you have to work out. `angle` is handed back
 * because the spoke to this disc is the same bearing.
 */
export function satellite(index: number, count: number): { x: number; y: number; angle: number } {
  const { cx, cy } = stageCentre();
  const angle = (-90 + (index * 360) / Math.max(1, count)) * (Math.PI / 180);
  return { x: cx + ORBIT_R * Math.cos(angle), y: cy + ORBIT_R * Math.sin(angle), angle };
}

/**
 * The spoke that carries sound from the hub to one disc, from the hub's rim to
 * the disc's own edge. Both ends stop at a circle rather than at a centre: a
 * line that ran into the middle of the disc would look like it was drawn to the
 * wrong place.
 */
export function spoke(angle: number): { x0: number; y0: number; x1: number; y1: number } {
  const { cx, cy } = stageCentre();
  const inner = HUB_D / 2;
  const outer = ORBIT_R - DISC_D / 2;
  return {
    x0: cx + inner * Math.cos(angle),
    y0: cy + inner * Math.sin(angle),
    x1: cx + outer * Math.cos(angle),
    y1: cy + outer * Math.sin(angle),
  };
}

/**
 * Everything one role paints, as literal class names.
 *
 * Literal because Tailwind scans source text: a class assembled from a variable
 * at runtime is a class that never gets generated, which is how
 * `bg-accent-muted/50` silently came to mean nothing in this codebase.
 */
export type RoleTone = {
  /** The concentric ring inside the disc. Established in styles/index.css. */
  ring: string;
  /** The role word under the device's name. */
  label: string;
  /** The disc's own outline, and its wash. */
  outline: string;
  wash: string;
  /** The spoke carrying sound to it. */
  wire: string;
};

export const TONE: Record<StageRole, RoleTone> = {
  /* The device the system plays directly. Accent, because accent is already
     what marks the part of the screen that belongs to a route. */
  primary: {
    ring: 'con-ring-main',
    label: 'text-type-primary',
    outline: 'border-type-primary',
    wash: 'bg-type-primary/[0.07] dark:bg-type-primary/[0.09]',
    wire: 'stroke-type-primary',
  },
  /* A copy. The accent's neighbour hue rather than a second accent: both mean
     "this route is live", and two unrelated colours would say they were
     unrelated things. */
  mirror: {
    ring: 'con-ring-copy',
    label: 'text-type-mirror',
    outline: 'border-type-mirror',
    wash: 'bg-type-mirror/[0.07] dark:bg-type-mirror/[0.09]',
    wire: 'stroke-type-mirror',
  },
  /* Hardware no route touches. Stays on the shared border: most devices are
     idle most of the time, and a ring where everything is tinted is a ring
     where the tint says nothing. It has no spoke at all — a device the route
     does not touch is not connected to anything, and the way to draw that is to
     draw nothing. */
  idle: {
    ring: 'con-ring-idle',
    label: 'text-text-muted',
    // No outline of its own: an idle disc is a thinner, clearer piece of glass
    // (`.glass-thin`), and a border colour here would fight that pane's rim.
    outline: '',
    wash: '',
    wire: 'stroke-type-idle',
  },
};

/**
 * The bloom around a lit disc.
 *
 * Inline rather than a utility class because the colour has to come from the
 * theme's channels, so it can differ between the light and dark palettes, and
 * because this is one property rather than a shape worth naming.
 *
 * Two rings, not one: a halo outside and a hairline inset inside the rim, so a
 * lit disc is a disc *with a second circle drawn in it* rather than a disc with
 * a coloured outline. The lens's own rim light and shadow stack are pulled in as
 * tokens rather than restated, because an inline `box-shadow` replaces the whole
 * `.glass` one — and a disc that loses its specular rim or its contact shadow
 * stops looking like glass and starts looking like a sticker.
 */
export function bloom(role: StageRole): CSSProperties {
  if (role === 'idle') return {};
  const channel = role === 'primary' ? '--type-primary-rgb' : '--type-mirror-rgb';
  return {
    boxShadow: [
      `0 0 0 4px rgb(var(${channel}) / 0.16)`,
      `inset 0 0 0 1px rgb(var(${channel}) / 0.22)`,
      'var(--glass-rim)',
      'var(--glass-shadow)',
    ].join(', '),
  };
}
