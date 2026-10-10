/**
 * The node board — the one place a route is drawn.
 *
 * Everything about the shape of the routing screen is arithmetic, and it all
 * answers from here: the programme under the cursor sits at the left-centre as
 * the hub, and what its sound goes out to is grouped into two panels down the
 * right edge — the primary device above, the copies and the programmes it is
 * fed into below. A wire from the hub's out-pin to a row is the route, and the
 * number badge on the row is the order it goes out in.
 *
 * Why arithmetic and not a measured layout: positions derive from the route
 * order, so a card and the wire meeting it cannot disagree by a frame. The one
 * number the board takes from outside is the height of the well it sits in —
 * the board fills it, so the stage never scrolls, and the copies panel scrolls
 * inside itself instead. `BOARD_W` is fixed (the app's own default window
 * measures wider than it); only the height is the well's answer.
 *
 * The column layout is what decides what the board can show without turning
 * into hair: one program per board, so a fan-out never crosses another
 * program's wires, and every destination is one row — a device or another
 * program's input — numbered in route order.
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
 * Width of the board, in CSS pixels: literals rather than measurements, and the
 * components take the panels' sizes from here instead of from Tailwind classes,
 * for the one reason that mattered on the board before this one and still does:
 * a wire drawn from `getBoundingClientRect` arrives a frame late and then
 * chases every layout pass. Fixed numbers mean the row and the wire that meets
 * it cannot disagree.
 */
export const BOARD_W = 640;
/** What the work area measures at the app's own default window. The board
 *  takes the well's own height once it has been measured; this is only the
 *  first frame's answer. */
export const BOARD_H = 470;

/** The programme under the cursor — the hub every wire leaves from. */
export const HUB_W = 190;
export const HUB_H = 84;
/** The hub sits one column in from the left edge; the column to its left is
 * reserved for the programmes feeding into it, so a feed appearing moves
 * nothing that is already on the board. */
export const HUB_X = 196;

/** The destination column: two grouped panels, the primary above the rest. */
export const GROUP_X = 430;
export const GROUP_W = 200;
/** Room between a panel's edge and the rows inside it. */
export const GROUP_PAD = 6;
/** A panel's title row: the group's name, and the way in for a new direction. */
export const GROUP_HEADER_H = 24;
/** The panel's own hairline, counted: its rows sit inside the border as well as
 *  inside the padding, and a wire that forgot the pixel would meet its row one
 *  pixel off. */
export const PANEL_BORDER = 1;

/** One destination row inside a panel. Its left edge is also its in-pin. */
export const ROW_X = GROUP_X + PANEL_BORDER + GROUP_PAD;
export const ROW_W = GROUP_W - (PANEL_BORDER + GROUP_PAD) * 2;
export const ROW_H = 52;
/** The gap between two rows in the same panel. */
export const ROW_GAP = 6;

/** One programme feeding sound *into* the hub. */
export const MINI_W = 140;
export const MINI_H = 52;
export const FEEDER_X = 16;

/** Side length of a pin — the stub a wire plugs into. Its centre sits on the
 *  edge it belongs to, which is what the ports below answer with. */
export const PIN_D = 11;

/** Breathing room at the board's top and bottom edges. */
const BOARD_MARGIN = 14;
/** The gap between the primary panel and the copies panel. */
const GROUP_GAP = 12;
/** Vertical breathing room at the top and bottom of the feeders' column. */
const COLUMN_MARGIN = 34;

/** How tall the primary panel is: its hairlines, its title, one row, and the
 *  padding around them. One row, always — the primary is a single device — and
 *  it is the panel's border box, so the row inside it fits to the pixel. */
export function primaryPanelHeight(): number {
  return PANEL_BORDER * 2 + GROUP_HEADER_H + GROUP_PAD * 2 + ROW_H;
}

/** Where the primary panel's top edge sits. It is anchored to the top of the
 *  board, as the first thing the column has to say. */
export function primaryPanelY(): number {
  return BOARD_MARGIN;
}

/** Where the copies panel's top edge sits: directly under the primary's. */
export function copiesPanelY(): number {
  return primaryPanelY() + primaryPanelHeight() + GROUP_GAP;
}

/**
 * How tall the copies panel may be.
 *
 * It takes everything left below the primary panel, so the two of them always
 * fit the board exactly and the stage never has to scroll. A row too many and
 * the panel scrolls inside itself rather than the board growing.
 */
export function copiesPanelHeight(height: number): number {
  return Math.max(GROUP_HEADER_H + GROUP_PAD * 2, height - copiesPanelY() - BOARD_MARGIN);
}

/** How tall a panel's scroll content is, for `rows` rows. */
export function panelContentHeight(rows: number): number {
  if (rows <= 0) return 0;
  return GROUP_PAD * 2 + rows * ROW_H + (rows - 1) * ROW_GAP;
}

/** The centre of row `index`, in the panel's own scroll content. */
export function rowContentY(index: number): number {
  return GROUP_PAD + index * (ROW_H + ROW_GAP) + ROW_H / 2;
}

/**
 * The centre of row `index` on the board: where the panel sits, less however
 * far it has been scrolled. The wire's endpoint rides with the row, so a
 * scrolled panel is one whose wires move with it rather than one whose wires
 * quietly point at where the rows used to be.
 */
export function rowPortY(panelY: number, index: number, scrollTop: number): number {
  return panelY + PANEL_BORDER + GROUP_HEADER_H + rowContentY(index) - scrollTop;
}

/**
 * Whether row `index` is inside the panel's visible area.
 *
 * A row scrolled out of the panel is not on screen, and a wire drawn to it
 * would run out past the panel's edge — so its wire is not drawn at all.
 */
export function rowVisible(
  panelY: number,
  panelHeight: number,
  index: number,
  scrollTop: number,
): boolean {
  const y = rowPortY(panelY, index, scrollTop);
  return y >= panelY + PANEL_BORDER + GROUP_HEADER_H && y <= panelY + panelHeight;
}

/**
 * A destination's number, as the badge and the wizard both teach it:
 * zero-padded, because "01" is the order and "1" is a count. Three places draw
 * it and the sketch in the first-run wizard draws it as 01/02 — one of those
 * literals drifting is exactly the kind of disagreement this file exists to
 * keep out of the board.
 */
export function orderLabel(ordinal: number): string {
  return String(ordinal + 1).padStart(2, '0');
}

/** The board's vertical middle: where the hub sits and its wires leave from. */
export function boardCentre(height: number): number {
  return height / 2;
}

/** Row distance for the feeders' column: comfortable while it fits, then
 *  compressed — never past the point where two cards would touch. */
function feederDy(count: number, height: number): number {
  if (count <= 1) return 0;
  const span = Math.max(0, height - COLUMN_MARGIN * 2 - MINI_H);
  return Math.max(MINI_H + 6, Math.min(78, Math.floor(span / (count - 1))));
}

/** Where the feeders' card `index` of `count` sits (top edge, in px). */
export function feederY(index: number, count: number, height: number): number {
  const dy = feederDy(count, height);
  const cy = boardCentre(height);
  return Math.round(cy + (index - (count - 1) / 2) * dy - MINI_H / 2);
}

/** The out-pin of the hub: the point every wire it emits leaves from. */
export function hubOutPort(height: number): { x: number; y: number } {
  return { x: HUB_X + HUB_W, y: boardCentre(height) };
}

/** The in-pin of the hub: where a feeder's wire arrives. */
export function hubInPort(height: number): { x: number; y: number } {
  return { x: HUB_X, y: boardCentre(height) };
}

/** The in-pin of a destination row: its own left edge, on the panel's border. */
export function rowInPort(panelY: number, index: number, scrollTop: number): { x: number; y: number } {
  return { x: ROW_X, y: rowPortY(panelY, index, scrollTop) };
}

/** The out-pin of the feeders' card `index`. */
export function feederOutPort(
  index: number,
  count: number,
  height: number,
): { x: number; y: number } {
  return { x: FEEDER_X + MINI_W, y: feederY(index, count, height) + MINI_H / 2 };
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
