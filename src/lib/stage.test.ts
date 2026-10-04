import { describe, expect, it } from 'vitest';
import { alreadyApplied } from './stage';

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
