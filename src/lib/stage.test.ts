import { describe, expect, it } from 'vitest';
import {
  BOARD_H,
  TARGET_H,
  alreadyApplied,
  boardHeight,
  feederY,
  hubOutPort,
  MINI_H,
  nodePath,
  targetInPort,
  targetY,
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
 * that a card and the wire that meets it agree: the column stays inside the
 * board, neighbouring cards never overlap, and a wire ends on the pin it names.
 */
describe('board geometry', () => {
  it('keeps a column of cards inside the board, however many there are', () => {
    for (const count of [1, 2, 3, 5, 8, 12]) {
      const height = boardHeight(count);
      const first = targetY(0, count, height);
      const last = targetY(count - 1, count, height) + TARGET_H;
      expect(first).toBeGreaterThanOrEqual(0);
      expect(last).toBeLessThanOrEqual(height);
    }
  });

  it('grows the board rather than squeezing cards into each other', () => {
    // The default board is what the app's own window measures; past that the
    // board gets taller and the well scrolls. What it must never do is close
    // the gap until two destinations touch.
    expect(boardHeight(3)).toBe(BOARD_H);
    expect(boardHeight(12)).toBeGreaterThan(BOARD_H);
    for (const count of [2, 3, 5, 8, 12, 20]) {
      const height = boardHeight(count);
      for (let index = 1; index < count; index += 1) {
        const above = targetY(index - 1, count, height) + TARGET_H;
        expect(targetY(index, count, height)).toBeGreaterThanOrEqual(above);
      }
    }
  });

  it('sizes the board for the feeding column too', () => {
    // The programmes sending sound *into* the hub are a column as well, and they
    // sit to its left. Sized only for the destinations, eight of them stack
    // above the top edge — and absolutely positioned children do not extend a
    // scroll area upwards, so those feeds become unreachable rather than merely
    // scrolled off. The budget is the taller of the two columns.
    const height = boardHeight(1, 8);
    expect(height).toBeGreaterThan(BOARD_H);
    expect(feederY(0, 8, height)).toBeGreaterThanOrEqual(0);
    expect(feederY(7, 8, height) + MINI_H).toBeLessThanOrEqual(height);
    for (let index = 1; index < 8; index += 1) {
      expect(feederY(index, 8, height)).toBeGreaterThanOrEqual(
        feederY(index - 1, 8, height) + MINI_H,
      );
    }
  });

  it('centres the column on the hub', () => {
    // The hub's out-pin sits at the board's vertical middle, and a column with
    // an odd count has to line up with it or the middle wire would be the only
    // one that runs straight.
    const height = boardHeight(3);
    expect(hubOutPort(height).y).toBeCloseTo(height / 2, 5);
    const middle = targetY(1, 3, height) + TARGET_H / 2;
    expect(middle).toBeCloseTo(height / 2, 5);
  });

  it('ends a wire at the pin it names', () => {
    const height = boardHeight(3);
    const from = hubOutPort(height);
    const to = targetInPort(1, 3, height);
    const path = nodePath(from.x, from.y, to.x, to.y);
    expect(path.startsWith(`M ${from.x} ${from.y}`)).toBe(true);
    expect(path.endsWith(`${to.x} ${to.y}`)).toBe(true);
  });

  it('stacks feeders with the same spacing rules', () => {
    for (const count of [1, 3, 6]) {
      const height = boardHeight(count);
      const first = feederY(0, count, height);
      const last = feederY(count - 1, count, height);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(last).toBeLessThanOrEqual(height);
    }
  });
});
