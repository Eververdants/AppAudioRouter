/**
 * The node board — the one place a route is drawn.
 *
 * Everything about the shape of the routing screen is arithmetic, and it all
 * answers from here: the programme under the cursor sits at the left-centre as
 * the hub, every destination is a card in the column at the right, and a wire
 * from the hub's out-pin to a card's in-pin *is* the route.
 *
 * Why a column board and not a free canvas: positions derive from the route
 * order (devices in delay order, feeds after them), so the wires are computed
 * rather than measured — a `getBoundingClientRect` here would put every wire a
 * frame behind every spring, and a board the user has to arrange is a board
 * that can be left messy. 640 × 470 is what the work area measures at the app's
 * own default 900 px window; it scrolls below that, it never squashes.
 *
 * The column layout also decides what the board can show without turning into
 * hair: one program per board, so a fan-out never crosses another program's
 * wires, and every destination is one card — a device or another program's
 * input — numbered in route order.
 */

/** What a destination is doing for the hub right now. */
export type BoardRole = 'primary' | 'mirror' | 'feed';

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
 * order the board draws and the store keeps live routes in, so the comparison
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
 * Size of the board, in CSS pixels. Literals rather than measurements, and the
 * components take their sizes from these instead of from Tailwind classes, for
 * the one reason that mattered on the board before this one and still does: a
 * wire drawn from `getBoundingClientRect` arrives a frame late and then chases
 * every layout pass. Fixed numbers mean the card and the wire that meets it
 * cannot disagree.
 */
export const BOARD_W = 640;
export const BOARD_H = 470;

/** The programme under the cursor — the hub every wire leaves from. */
export const HUB_W = 190;
export const HUB_H = 84;
/** The hub sits one column in from the left edge; the column to its left is
 * reserved for the programmes feeding into it, so a feed appearing moves
 * nothing that is already on the board. */
export const HUB_X = 196;
export const HUB_Y = Math.round(BOARD_H / 2 - HUB_H / 2);

/** One destination: an output device, or another programme's input. */
export const TARGET_W = 190;
export const TARGET_H = 62;
/** The destinations' column; the ghost "add destination" card lives here too. */
export const TARGET_X = 436;

/** One programme feeding sound *into* the hub. */
export const MINI_W = 140;
export const MINI_H = 52;
export const FEEDER_X = 16;

/** Side length of a pin — the stub a wire plugs into. */
export const PIN_D = 11;

/** Vertical breathing room at the top and bottom edges of the column. */
const COLUMN_MARGIN = 34;
/** The tallest gap two neighbouring cards may sit at. */
const MAX_ROW_DY = 92;
/** The tightest gap two neighbouring cards may sit at. */
const MIN_ROW_GAP = 10;

/**
 * Row distance for `count` cards in a column.
 *
 * Comfortable while the column fits, then compressed — but never past the point
 * where two cards would touch: past that the board grows instead (see
 * [`boardHeight`]). A compressed row that overlapped its neighbour would hide
 * a destination behind another one, which is worse than a scrollbar.
 */
function rowDy(count: number, height: number, maxDy: number): number {
  if (count <= 1) return 0;
  const span = height - COLUMN_MARGIN * 2 - TARGET_H;
  return Math.max(TARGET_H + MIN_ROW_GAP, Math.min(maxDy, Math.floor(span / (count - 1))));
}

/**
 * How tall the board has to be to hold `count` cards without squeezing them.
 *
 * `BOARD_H` is what the work area measures at the app's own default window;
 * a plan longer than that makes the board taller and the well scrolls, rather
 * than the cards closing in on each other.
 */
export function boardHeight(count: number): number {
  const needed = COLUMN_MARGIN * 2 + count * TARGET_H + (count - 1) * MIN_ROW_GAP;
  return Math.max(BOARD_H, needed);
}

/** The board's vertical middle: where the hub sits and its wires leave from. */
export function boardCentre(height: number): number {
  return height / 2;
}

/** Where the target column's card `index` of `count` sits (top edge, in px). */
export function targetY(index: number, count: number, height: number): number {
  const dy = rowDy(count, height, MAX_ROW_DY);
  const cy = boardCentre(height);
  return Math.round(cy + (index - (count - 1) / 2) * dy - TARGET_H / 2);
}

/** Where the feeders' card `index` of `count` sits (top edge, in px). */
export function feederY(index: number, count: number, height: number): number {
  const dy = rowDy(count, height, 78);
  const cy = boardCentre(height);
  return Math.round(cy + (index - (count - 1) / 2) * dy - MINI_H / 2);
}

/** The out-pin of the hub: the point every wire it emits leaves from. */
export function hubOutPort(height: number): { x: number; y: number } {
  return { x: HUB_X + HUB_W + PIN_D / 2, y: boardCentre(height) };
}

/** The in-pin of the hub: where a feeder's wire arrives. */
export function hubInPort(height: number): { x: number; y: number } {
  return { x: HUB_X - PIN_D / 2, y: boardCentre(height) };
}

/** The in-pin of the target column's card `index`. */
export function targetInPort(
  index: number,
  count: number,
  height: number,
): { x: number; y: number } {
  return { x: TARGET_X - PIN_D / 2, y: targetY(index, count, height) + TARGET_H / 2 };
}

/** The out-pin of the feeders' card `index`. */
export function feederOutPort(
  index: number,
  count: number,
  height: number,
): { x: number; y: number } {
  return { x: FEEDER_X + MINI_W + PIN_D / 2, y: feederY(index, count, height) + MINI_H / 2 };
}

/**
 * The wire between two pins.
 *
 * A horizontal-ease-then-vertical-ease-then-horizontal S: the shape node
 * editors draw between vertically offset cards, and the reason a fan of wires
 * out of one pin separates within the first few pixels instead of bunching
 * into a rope. Control points sit at fixed fractions of the run, so two wires
 * to cards at different heights cannot cross near their shared origin.
 */
export function nodePath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = x2 - x1;
  return `M ${x1} ${y1} C ${x1 + dx * 0.4} ${y1}, ${x1 + dx * 0.6} ${y2}, ${x2} ${y2}`;
}
