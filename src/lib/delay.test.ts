import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DELAY_RANGE_MS,
  DEFAULT_DELAY_STEP_MS,
  DELAY_STEP_STORAGE_KEY,
  clampDelay,
  clampStep,
  formatDelaySigned,
  formatStep,
  rangeSeconds,
  readDelayStep,
  stepDelay,
} from './delay';

describe('clampStep', () => {
  it('keeps a step inside the offered options', () => {
    expect(clampStep(1)).toBe(1);
    expect(clampStep(10)).toBe(10);
    expect(clampStep(50)).toBe(50);
    expect(clampStep(1000)).toBe(1000);
  });

  it('clamps to the bounds instead of returning something unusable', () => {
    expect(clampStep(0)).toBe(1);
    expect(clampStep(-5)).toBe(1);
    expect(clampStep(50_000)).toBe(1000);
  });

  it('rounds fractional input to whole milliseconds', () => {
    expect(clampStep(2.4)).toBe(2);
    expect(clampStep(2.6)).toBe(3);
  });

  it('falls back to the default for values that are not numbers', () => {
    expect(clampStep(Number.NaN)).toBe(DEFAULT_DELAY_STEP_MS);
    expect(clampStep(Number.POSITIVE_INFINITY)).toBe(DEFAULT_DELAY_STEP_MS);
    expect(clampStep(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_DELAY_STEP_MS);
  });
});

describe('readDelayStep', () => {
  it('returns the default when nothing is stored', () => {
    expect(readDelayStep()).toBe(DEFAULT_DELAY_STEP_MS);
  });

  it('honours a stored step inside the bounds', () => {
    localStorage.setItem(DELAY_STEP_STORAGE_KEY, '50');
    expect(readDelayStep()).toBe(50);
  });

  it('clamps a stored step that is out of bounds', () => {
    localStorage.setItem(DELAY_STEP_STORAGE_KEY, '99999');
    expect(readDelayStep()).toBe(1000);
  });

  it('falls back to the default when the stored value is garbage', () => {
    localStorage.setItem(DELAY_STEP_STORAGE_KEY, 'not-a-number');
    expect(readDelayStep()).toBe(DEFAULT_DELAY_STEP_MS);
  });

  it('survives storage being unavailable', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    getItem.mockImplementation(() => {
      throw new Error('storage disabled');
    });
    expect(readDelayStep()).toBe(DEFAULT_DELAY_STEP_MS);
  });
});

describe('clampDelay', () => {
  it('leaves a value inside the range alone', () => {
    expect(clampDelay(250, 5000)).toBe(250);
    expect(clampDelay(-250, 5000)).toBe(-250);
    expect(clampDelay(0, 5000)).toBe(0);
  });

  it('clamps to both ends of the configured range', () => {
    expect(clampDelay(9_000, 5000)).toBe(5000);
    expect(clampDelay(-9_000, 5000)).toBe(-5000);
  });

  it('rounds to whole milliseconds', () => {
    expect(clampDelay(10.6, 5000)).toBe(11);
    expect(clampDelay(-10.6, 5000)).toBe(-11);
  });

  it('treats a non-finite value as zero rather than writing NaN', () => {
    expect(clampDelay(Number.NaN, 5000)).toBe(0);
    expect(clampDelay(Number.POSITIVE_INFINITY, 5000)).toBe(0);
  });

  it('treats a non-finite range as the store default rather than NaN', () => {
    expect(clampDelay(400, Number.NaN)).toBe(400);
    expect(clampDelay(999_999, Number.NaN)).toBe(DEFAULT_DELAY_RANGE_MS);
  });
});

describe('formatDelaySigned', () => {
  it('writes zero without a sign', () => {
    expect(formatDelaySigned(0)).toBe('0');
  });

  it('writes a positive value with a plus', () => {
    expect(formatDelaySigned(250)).toBe('+250');
  });

  it('writes a negative value with a real minus sign and no sign duplication', () => {
    expect(formatDelaySigned(-250)).toBe('\u2212250');
    expect(formatDelaySigned(-250)).not.toContain('--');
  });
});

describe('stepDelay', () => {
  it('steps up and down by the configured amount', () => {
    expect(stepDelay(0, 1, 5000, 10)).toBe(10);
    expect(stepDelay(0, -1, 5000, 10)).toBe(-10);
  });

  it('snaps an off-grid value onto the current step first', () => {
    // 7 was left behind by a 1 ms step; with a 10 ms step it lands on the
    // nearest grid point (10) before stepping, so the result is 20 / 0 rather
    // than 17 / -3 — the value never keeps an offset from a coarser step.
    expect(stepDelay(7, 1, 5000, 10)).toBe(20);
    expect(stepDelay(7, -1, 5000, 10)).toBe(0);
  });

  it('applies several steps at once', () => {
    expect(stepDelay(0, 1, 5000, 10, 3)).toBe(30);
    expect(stepDelay(0, -1, 5000, 10, 3)).toBe(-30);
  });

  it('never leaves the configured range', () => {
    expect(stepDelay(4999, 1, 5000, 10, 2)).toBe(5000);
    expect(stepDelay(-4999, -1, 5000, 10, 2)).toBe(-5000);
  });

  it('stays finite for a zero step', () => {
    // Nothing passes 0 today; the guard keeps it from producing NaN.
    expect(Number.isFinite(stepDelay(10, 1, 5000, 0))).toBe(true);
  });
});

describe('rangeSeconds / formatStep', () => {
  it('rounds a range to whole seconds', () => {
    expect(rangeSeconds(1000)).toBe(1);
    expect(rangeSeconds(5000)).toBe(5);
    expect(rangeSeconds(1500)).toBe(2);
  });

  it('reads whole seconds as seconds and the rest as milliseconds', () => {
    expect(formatStep(1000)).toBe('1 s');
    expect(formatStep(2000)).toBe('2 s');
    expect(formatStep(50)).toBe('50 ms');
    expect(formatStep(1500)).toBe('1500 ms');
  });
});
