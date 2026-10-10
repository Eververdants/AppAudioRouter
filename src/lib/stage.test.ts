import { describe, expect, it } from 'vitest';
import {
  BOARD_H,
  GROUP_HEADER_H,
  GROUP_PAD,
  MINI_H,
  PANEL_BORDER,
  ROW_GAP,
  ROW_H,
  alreadyApplied,
  feederY,
  hubOutPort,
  nodePath,
  panelBodyHeight,
  panelColumn,
  rowContentY,
  rowInPort,
  rowPortY,
  rowVisible,
} from './stage';

/**
 * The guard that keeps the apply affordance quiet when the screen already shows
 * the answer: right after a route, and on a programme whose remembered route was
 * just restored, staged and live are the same list and there is nothing to ask.
 */
describe('alreadyApplied', () => {
  it('is false when nothing is staged or nobody is selected', () => {
    const routed = { 1001: ['speakers'] };
    expect(alreadyApplied([], [1001], routed)).toBe(false);
    expect(alreadyApplied(['speakers'], [], routed)).toBe(false);
  });

  it('is true when every selected programme plays exactly the staged list', () => {
    const routed = { 1001: ['tv', 'speakers'], 1002: ['tv', 'speakers'] };
    expect(alreadyApplied(['tv', 'speakers'], [1001, 1002], routed)).toBe(true);
  });

  it('is false when a selected programme has no route at all', () => {
    expect(alreadyApplied(['speakers'], [1001], {})).toBe(false);
    expect(alreadyApplied(['speakers'], [1001], { 1001: undefined })).toBe(false);
  });

  it('is false when the route holds the same devices in another order', () => {
    // Live routes are kept in delay order and the stage draws that same order,
    // so a difference here means the apply would produce a different primary —
    // which is a real change, not the answer already on screen.
    const routed = { 1001: ['speakers', 'tv'] };
    expect(alreadyApplied(['tv', 'speakers'], [1001], routed)).toBe(false);
  });

  it('is false when one programme in the batch is somewhere else', () => {
    const routed = { 1001: ['tv'], 1002: ['speakers'] };
    expect(alreadyApplied(['tv'], [1001, 1002], routed)).toBe(false);
  });
});

/**
 * The board's arithmetic.
 *
 * Wires are computed rather than measured, so the one thing that has to hold is
 * that a row and the wire that meets it agree: both panels stay inside the
 * board for whatever height the well reports, rows never overlap, and a wire
 * ends on the pin it names.
 */
describe('board geometry', () => {
  it('keeps the column inside the board, whatever height the well reports', () => {
    // The board takes the well's own height, so no height and no route length
    // may push a panel off the board: that is what replaced the well's
    // scrollbar.
    for (const height of [320, 470, 600, 900]) {
      for (const rows of [0, 1, 5, 40]) {
        const column = panelColumn(height, rows);
        expect(column.primaryY).toBeGreaterThanOrEqual(0);
        expect(column.copiesY).toBeGreaterThanOrEqual(column.primaryY + column.primaryHeight);
        expect(column.copiesY + column.copiesHeight).toBeLessThanOrEqual(height);
      }
    }
  });

  it('centres the column on the hub, however long the route is', () => {
    // The fan of wires leaves the hub's pin with something to reach on either
    // side of it: the column's own middle is the board's middle.
    for (const rows of [0, 1, 4, 30]) {
      const column = panelColumn(BOARD_H, rows);
      const middle = column.primaryY + (column.copiesY + column.copiesHeight - column.primaryY) / 2;
      expect(Math.abs(middle - BOARD_H / 2)).toBeLessThanOrEqual(1);
    }
  });

  it('gives the copies panel its content height until the board runs out', () => {
    // A short route is a short column, not a dashed box running to the floor;
    // a long one stops at the board's edge and scrolls inside itself.
    const short = panelColumn(600, 2);
    // Its title row, its hairlines and its two rows: nothing held open for a
    // longer route than the one on screen.
    expect(short.copiesHeight).toBeLessThan(200);
    expect(short.copiesHeight).toBe(panelBodyHeight(2) + 26);
    const long = panelColumn(600, 40);
    expect(long.copiesHeight).toBeLessThan(panelBodyHeight(40));
    expect(long.copiesY + long.copiesHeight).toBeLessThanOrEqual(600);
  });

  it('ends an overflowing copies panel halfway through a row', () => {
    // A panel with no room left has to say so by itself: the cut lands on a
    // row's centre, so exactly half of that row shows and the edge reads as
    // "there is more below" without a label or an arrow.
    for (const height of [400, 470, 560]) {
      const column = panelColumn(height, 40);
      const body = column.copiesHeight - (PANEL_BORDER * 2 + GROUP_HEADER_H);
      const index = Math.round((body - GROUP_PAD - ROW_H / 2) / (ROW_H + ROW_GAP));
      expect(index).toBeGreaterThanOrEqual(0);
      expect(rowContentY(index)).toBeCloseTo(body, 6);
      // ...and the wire to that half-visible row is drawn, so the cut row is
      // still pointed at rather than left hanging.
      expect(rowVisible(column.copiesY, column.copiesHeight, index, 0)).toBe(true);
    }
  });

  it('stacks rows without letting them touch', () => {
    for (const rows of [1, 2, 5, 12, 40]) {
      const body = panelBodyHeight(rows);
      for (let index = 1; index < rows; index += 1) {
        const above = rowContentY(index - 1) + ROW_H / 2;
        expect(rowContentY(index) - ROW_H / 2).toBeGreaterThanOrEqual(above);
      }
      const last = rowContentY(rows - 1) + ROW_H / 2;
      expect(last).toBeLessThanOrEqual(body);
    }
    // An empty panel is as tall as a one-row one, so the column does not
    // shuffle the moment the first copy arrives.
    expect(panelBodyHeight(0)).toBe(panelBodyHeight(1));
    expect(panelBodyHeight(2) - panelBodyHeight(1)).toBe(ROW_H + ROW_GAP);
  });

  it('rides a row and its port with the panel scroll', () => {
    // The wire has to move with the row it belongs to, or scrolling the panel
    // would leave every line pointing at where the rows used to be.
    const top = panelColumn(BOARD_H, 2).copiesY;
    expect(rowPortY(top, 0, 0) - rowPortY(top, 0, 40)).toBe(40);
  });

  it('leaves a row scrolled out of the panel without a wire to meet', () => {
    const column = panelColumn(BOARD_H, 2);
    expect(rowVisible(column.copiesY, column.copiesHeight, 0, 0)).toBe(true);
    expect(rowVisible(column.copiesY, column.copiesHeight, 0, 100000)).toBe(false);
  });

  it('centres the hub on the board', () => {
    // The hub's out-pin sits at the board's vertical middle, and the wire that
    // leaves it is the one every route is read from.
    expect(hubOutPort(BOARD_H).y).toBeCloseTo(BOARD_H / 2, 5);
  });

  it('ends a wire at the pin it names', () => {
    const column = panelColumn(BOARD_H, 1);
    const from = hubOutPort(BOARD_H);
    const to = rowInPort(column.primaryY, 0, 0);
    const path = nodePath(from.x, from.y, to.x, to.y);
    expect(path.startsWith(`M ${from.x} ${from.y}`)).toBe(true);
    expect(path.endsWith(`${to.x} ${to.y}`)).toBe(true);
  });

  it('stacks feeders inside the board', () => {
    for (const count of [1, 3, 6]) {
      const first = feederY(0, count, BOARD_H);
      const last = feederY(count - 1, count, BOARD_H);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(last + MINI_H).toBeLessThanOrEqual(BOARD_H);
    }
  });
});
