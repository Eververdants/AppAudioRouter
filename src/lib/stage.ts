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
 * Whether every selected programme is already playing through exactly what is
 * staged.
 *
 * Nothing is a question when the answer is already on screen: this is the state
 * the store lands in right after a route, and the state a programme with a
 * remembered route starts in. Asking there — lighting an apply affordance,
 * showing a sentence — would be asking someone to confirm what they can hear.
 *
 * Both sides are read in the order the route goes out in (`orderByDelay`), the
 * order the stage draws and the store keeps live routes in, so the comparison
 * is like with like.
 */
export function alreadyApplied(
  staged: string[],
  pids: number[],
  routedPids: Record<number, string[] | undefined>,
): boolean {
  if (staged.length === 0 || pids.length === 0) return false;
  return pids.every((pid) => {
    const ids = routedPids[pid];
    return (
      ids !== undefined &&
      ids.length === staged.length &&
      ids.every((id, index) => id === staged[index])
    );
  });
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
  /** The lit disc's own outline. */
  outline: string;
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
    wire: 'stroke-type-primary',
  },
  /* A copy. The accent's neighbour hue rather than a second accent: both mean
     "this route is live", and two unrelated colours would say they were
     unrelated things. */
  mirror: {
    ring: 'con-ring-copy',
    label: 'text-type-mirror',
    outline: 'border-type-mirror',
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
    // No outline of its own: an idle disc is an unfilled hairline circle on the
    // stage's plane, and a second border colour inside it would say "wired"
    // without a wire to back the claim.
    outline: '',
    wire: 'stroke-type-idle',
  },
};
