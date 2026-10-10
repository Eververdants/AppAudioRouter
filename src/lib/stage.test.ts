import { describe, expect, it } from 'vitest';
import {
  BOARD_H,
  GROUP_HEADER_H,
  MINI_H,
  ROW_GAP,
  ROW_H,
  alreadyApplied,
  copiesPanelHeight,
  copiesPanelY,
  feederY,
  hubOutPort,
  nodePath,
  panelContentHeight,
  primaryPanelHeight,
  primaryPanelY,
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
  it('keeps both panels inside the board, whatever height the well reports', () => {
    // The board takes the well's own height, so no height may push a panel off
    // the bottom: that is what replaced the well's scrollbar.
    for (const height of [320, 470, 600, 900]) {
      const primaryTop = primaryPanelY();
      const primaryBottom = primaryTop + primaryPanelHeight();
      const copiesTop = copiesPanelY();
      const copiesBottom = copiesTop + copiesPanelHeight(height);
      expect(primaryTop).toBeGreaterThanOrEqual(0);
      expect(copiesTop).toBeGreaterThanOrEqual(primaryBottom);
      expect(copiesBottom).toBeLessThanOrEqual(height);
    }
  });

  it('never squeezes the copies panel below its own title row', () => {
    // A board shorter than the two panels still has to draw something; the
    // panel gives up room, not the way in for a new destination.
    expect(copiesPanelHeight(10)).toBeGreaterThan(GROUP_HEADER_H);
  });

  it('stacks rows without letting them touch', () => {
    for (const rows of [1, 2, 5, 12, 40]) {
      const content = panelContentHeight(rows);
      for (let index = 1; index < rows; index += 1) {
        const above = rowContentY(index - 1) + ROW_H / 2;
        expect(rowContentY(index) - ROW_H / 2).toBeGreaterThanOrEqual(above);
      }
      const last = rowContentY(rows - 1) + ROW_H / 2;
      expect(last).toBeLessThanOrEqual(content);
    }
    expect(panelContentHeight(0)).toBe(0);
    expect(panelContentHeight(2) - panelContentHeight(1)).toBe(ROW_H + ROW_GAP);
  });

  it('rides a row and its port with the panel scroll', () => {
    // The wire has to move with the row it belongs to, or scrolling the panel
    // would leave every line pointing at where the rows used to be.
    const top = copiesPanelY();
    expect(rowPortY(top, 0, 0) - rowPortY(top, 0, 40)).toBe(40);
  });

  it('leaves a row scrolled out of the panel without a wire to meet', () => {
    const top = copiesPanelY();
    const height = copiesPanelHeight(BOARD_H);
    expect(rowVisible(top, height, 0, 0)).toBe(true);
    expect(rowVisible(top, height, 0, 100000)).toBe(false);
  });

  it('centres the hub on the board', () => {
    // The hub's out-pin sits at the board's vertical middle, and the wire that
    // leaves it is the one every route is read from.
    expect(hubOutPort(BOARD_H).y).toBeCloseTo(BOARD_H / 2, 5);
  });

  it('ends a wire at the pin it names', () => {
    const from = hubOutPort(BOARD_H);
    const to = rowInPort(primaryPanelY(), 0, 0);
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
