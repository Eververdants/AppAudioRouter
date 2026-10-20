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
 * Both sides are read in the order the route goes out in — the plan's own
 * order, which is what the board draws and the store keeps live routes in — so
 * the comparison is like with like.
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
export const HUB_X = 160;

/** The destination column: two grouped panels, the primary above the rest. The
 *  pair is centred on the hub, so the whole board reads as one figure rather
 *  than as a card pushed against the right edge. The panel edge leaves the
 *  hub's out-pin a corridor wide enough for the wires to turn in: a curve
 *  given no horizontal room reads as a kinked Z, not as a line. */
export const GROUP_X = 398;
export const GROUP_W = 212;
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
export const MINI_W = 120;
export const MINI_H = 52;
export const FEEDER_X = 12;

/** Side length of a pin — the stub a wire plugs into. Its centre sits on the
 *  edge it belongs to, which is what the ports below answer with. */
export const PIN_D = 11;

/** The breathing room the column reserves at the board's top and bottom when it
 *  works out how much room the panels have. The centring itself is clamped at
 *  0 rather than at this margin: a well too short to hold the column must keep
 *  it inside the board, not push its top out of it. */
const BOARD_MARGIN = 14;
/** The gap between the primary panel and the copies panel. */
const GROUP_GAP = 14;
/** Vertical breathing room at the top and bottom of the feeders' column. */
const COLUMN_MARGIN = 34;

/** The smallest copies panel the board will draw at all: its hairlines and its
 *  title row, with an empty body. A panel with no room left is never shrunk
 *  below this — it stops with a row cut in half instead (see `peekBodyHeight`). */
const COPIES_MIN_H = PANEL_BORDER * 2 + GROUP_HEADER_H;

/** The shortest board that can still hold the whole destination column: the
 *  primary panel, the gap, and the smallest copies panel there is. Below this
 *  the column runs off the bottom edge, whatever `panelColumn` does with the
 *  room it is given — see the note on `panelColumn`. */
export const COLUMN_MIN_H = primaryPanelHeight() + GROUP_GAP + COPIES_MIN_H;

/**
 * How tall a panel's body is for `rows` rows.
 *
 * An empty panel is as tall as a one-row one: the column is centred, so a body
 * that grew when the first copy arrived would shuffle both panels. `rows` is 0
 * only where the body is showing its own sentence instead.
 */
export function panelBodyHeight(rows: number): number {
  if (rows <= 0) return GROUP_PAD * 2 + ROW_H;
  return GROUP_PAD * 2 + rows * ROW_H + (rows - 1) * ROW_GAP;
}

/** A panel's border-box height for a body of `body` px. */
function panelHeight(body: number): number {
  return PANEL_BORDER * 2 + GROUP_HEADER_H + body;
}

/** The primary panel's height: one row, always, because the primary is a single
 *  device. Fixed so the wire to it never has to be re-derived. */
export function primaryPanelHeight(): number {
  return panelHeight(panelBodyHeight(1));
}

/**
 * The body height of a scrolling panel: whole rows plus the top half of the
 * next one.
 *
 * A panel that has run out of room must say so by itself — a row cut through
 * the middle is the oldest answer to "there is more below", and it needs no
 * label, no arrow and no scrollbar to be read. So when the rows do not fit, the
 * panel takes the height of as many whole rows as fit plus half a row, and the
 * cut edge does the talking (`Panel` adds a soft fade under it on top).
 *
 * `availableBody` is what the board has left for the body, border and title row
 * already removed.
 */
function peekBodyHeight(availableBody: number): number {
  // The most whole rows whose centre still fits, which is the row the panel ends
  // halfway through: the cut edge lands on a row's own middle, so exactly half
  // of that row shows.
  const rowsThatFit = Math.floor((availableBody - GROUP_PAD - ROW_H / 2) / (ROW_H + ROW_GAP));
  return Math.min(availableBody, rowContentY(Math.max(0, rowsThatFit)));
}

/** Where the two panels sit on the board. */
export interface PanelColumn {
  primaryY: number;
  primaryHeight: number;
  copiesY: number;
  copiesHeight: number;
}

/**
 * The two panels as one column, centred on the hub: the primary above the line
 * the wires leave from, every other destination below it. So the fan of wires
 * leaves the hub's pin with something to reach on both sides of it, and the
 * column has the same room above it as below.
 *
 * The copies panel takes its content's height — an empty board is a short
 * column in the middle, not a dashed box running to the floor — but never more
 * than what is left, so the stage still never scrolls: past that the panel
 * scrolls inside itself.
 *
 * The column does have a floor, and the sentence above used to claim it did
 * not: the primary panel (90), the gap between the two (14) and the smallest
 * copies panel the board draws at all (26 — its hairlines and title row, with a
 * body of nothing) come to `COLUMN_MIN_H`. Below that, nothing keeps the column
 * inside the board short of overlapping the panels, so the claim only holds from
 * that height up — which the window cannot ask for: at its own `minHeight` the
 * well still measures a few hundred. `stage.test.ts` pins the floor, so nobody
 * has to re-derive it from those three literals again.
 */
export function panelColumn(height: number, rows: number): PanelColumn {
  const primaryHeight = primaryPanelHeight();
  // Everything the column may take: the board's height, less both margins, the
  // primary panel and the gap between the two. Never negative, so a well too
  // short to hold the column still keeps it inside itself instead of letting it
  // run off the bottom edge — the board never scrolls, whatever height it is
  // given.
  const room = Math.max(0, height - BOARD_MARGIN * 2 - primaryHeight - GROUP_GAP);
  const wanted = panelHeight(panelBodyHeight(rows));
  // Content that fits takes its own height; one that does not stops with a row
  // cut in half, so the panel itself shows that there is more to scroll to.
  const copiesHeight =
    wanted <= room ? wanted : COPIES_MIN_H + peekBodyHeight(Math.max(0, room - COPIES_MIN_H));
  const top = Math.max(0, Math.round((height - primaryHeight - GROUP_GAP - copiesHeight) / 2));
  return {
    primaryY: top,
    primaryHeight,
    copiesY: top + primaryHeight + GROUP_GAP,
    copiesHeight,
  };
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

/** The gap two feeder cards may be squeezed down to before they touch. */
const FEEDER_MIN_GAP = 6;
/** The pitch the feeders' column holds while there is room for it. */
const FEEDER_COMFORT_PITCH = 78;
/** The tightest pitch two feeder cards can take: a card plus that gap. The
 *  column may be compressed to it, never past it. */
const FEEDER_MIN_PITCH = MINI_H + FEEDER_MIN_GAP;

/** Row distance for the feeders' column: comfortable while it fits, then
 *  compressed — never past the point where two cards would touch.
 *
 *  Exported because the seat window is only honest at the pitch the cards
 *  actually sit at: `feederColumn` reads `feederY`, `stage.test.ts` pins that the
 *  compression has a floor, and re-deriving the number anywhere else is how a
 *  wire and a card end up disagreeing. */
export function feederPitch(count: number, height: number): number {
  if (count <= 1) return 0;
  const span = Math.max(0, height - COLUMN_MARGIN * 2 - MINI_H);
  return Math.max(FEEDER_MIN_PITCH, Math.min(FEEDER_COMFORT_PITCH, Math.floor(span / (count - 1))));
}

/**
 * Whether feeder card `index` of `count` still shows at least half of itself.
 *
 * With `MINI_H <= height` that reads as the card's *centre* lying on the board:
 * the top clip leaves half a card whenever the centre has not gone past 0, and
 * the bottom clip likewise at `height`. A card past that is a sliver nobody can
 * aim at, so it is drawn neither as a card nor as a wire.
 */
function feederSeated(index: number, count: number, height: number): boolean {
  const centre = feederY(index, count, height) + MINI_H / 2;
  return centre >= 0 && centre <= height;
}

/**
 * How many feeder cards the board can seat.
 *
 * `feederPitch` stops compressing at [`FEEDER_MIN_PITCH`](58) — two cards that
 * are one gap apart are as close as they may be — and the column is centred on
 * the hub, so the cards it can hold is the cards whose *centre* lies on the
 * board at that pitch: one every `58` px of height, plus the middle one. Past
 * this count the outermost card is under half visible, which is nobody's card to
 * draw: it is a focusable button nobody can aim at, and the board is the only
 * place a route is drawn. So the answer is a number the column can show, not a
 * claim that every feed fits — nine programs feeding one hub is a rare board,
 * but it is a reachable one, and the half-cards at the two ends plus the fading
 * edges are what says the column goes on (`feederColumn`).
 */
export function feedersFitting(height: number): number {
  if (height < MINI_H) return 0;
  return Math.floor(height / FEEDER_MIN_PITCH) + 1;
}

/** The part of the feeders' column the board shows, and which edge cuts it. */
export interface FeederColumn {
  /** First feeder index with a seat; every card before it is off the board. */
  first: number;
  /** How many cards are seated, counting from `first`. Never more than
   *  `feedersFitting(height)`, and never more than `count`. */
  seated: number;
  /** Whether the column carries on past the board's top / bottom edge — cards
   *  exist there that the board cannot show, so that is the edge to fade. True
   *  for both when nothing at all is seated: the feeders are there, the well is
   *  simply too short for any of them. */
  cutAbove: boolean;
  cutBelow: boolean;
}

/**
 * The seat window of the feeders' column: the cards the board can show for
 * `count` feeders, and the edges it cuts them on.
 *
 * The stage never scrolls and this column has no panel to scroll inside itself,
 * so the cut is the whole treatment, and it is one decision rather than two:
 * whoever draws the column asks this one function for the window and draws both
 * the card and the wire from it — a card the user can half-see keeps the line
 * that says where its sound goes, and a card under half leaves without either.
 * Then the edge the column runs on gets `Panel`'s soft fade, which is what makes
 * a half-card read as "there are more of these" instead of a broken render.
 *
 * The cards run downhill — `feederY` grows with the index — so the seated ones
 * are one unbroken window and only the two ends of the column can be cut.
 */
export function feederColumn(count: number, height: number): FeederColumn {
  // Nothing seated: the cards exist and the board shows none of them, so both
  // edges of the column are cut (or, with no feeders at all, neither is).
  const empty: FeederColumn = {
    first: 0,
    seated: 0,
    cutAbove: count > 0,
    cutBelow: count > 0,
  };
  if (count <= 0 || height < MINI_H) return empty;
  let first = 0;
  while (first < count && !feederSeated(first, count, height)) first += 1;
  let last = count - 1;
  while (last >= 0 && !feederSeated(last, count, height)) last -= 1;
  // The window is what the pitch leaves visible; the capacity is what the board
  // can seat at its tightest pitch. Both say the same thing today — the pitch
  // never goes under `FEEDER_MIN_PITCH` — and taking the smaller of the two is
  // what keeps `seated <= feedersFitting(height)` a fact of this file rather
  // than an emergent property of two functions that do not talk to each other.
  const seated = Math.min(Math.max(0, last - first + 1), feedersFitting(height));
  if (seated === 0) return empty;
  return {
    first,
    seated,
    cutAbove: first > 0,
    cutBelow: first + seated < count,
  };
}

/** Where the feeders' card `index` of `count` sits (top edge, in px). */
export function feederY(index: number, count: number, height: number): number {
  const dy = feederPitch(count, height);
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
export function rowInPort(
  panelY: number,
  index: number,
  scrollTop: number,
): { x: number; y: number } {
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
 * A serpentine whose two controls sit on the far corners of the run: the first
 * holds the arrival x at the departure y, the second holds the departure x at
 * the arrival y. x therefore travels monotonically — vertical tangent exactly
 * at the midpoint — and y follows a smoothstep, so the line leaves its pin
 * horizontally, spends the middle of the run vertical, and lands horizontally
 * on the other pin without a kink anywhere. Wires to rows at different heights
 * stay nested (each keeps its own y band the whole way), so a fan out of one
 * pin peels into strands instead of crossing itself.
 */
export function nodePath(x1: number, y1: number, x2: number, y2: number): string {
  return `M ${x1} ${y1} C ${x2} ${y1}, ${x1} ${y2}, ${x2} ${y2}`;
}
