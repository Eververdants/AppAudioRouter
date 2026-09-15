/** Delay compensation helpers, shared by the delay panel and the settings page. */

/** Step of the delay controls in milliseconds: the controls step by whole seconds. */
export const DELAY_STEP_MS = 1000;

/** Delay ranges (milliseconds, half-range) offered by the settings, and the
 * initial store value until the backend reports the persisted one. */
export const DELAY_RANGE_OPTIONS = [1000, 2000, 5000, 10000] as const;
export const DEFAULT_DELAY_RANGE_MS = 5000;

/** Clamp a delay to the configured ± range, rounded to whole milliseconds. */
export function clampDelay(ms: number, rangeMs: number): number {
  const rounded = Math.round(Number.isFinite(ms) ? ms : 0);
  return Math.max(-rangeMs, Math.min(rangeMs, rounded));
}

/**
 * Next delay when stepping one whole second up or down.
 *
 * The current value is snapped to the step first, so a value stored by an
 * earlier version (presets topped out at 500 ms, e.g. 150 ms) lands on a whole
 * second instead of 1150 ms.
 */
export function stepDelay(ms: number, direction: 1 | -1, rangeMs: number): number {
  const snapped = Math.round(ms / DELAY_STEP_MS) * DELAY_STEP_MS;
  return clampDelay(snapped + direction * DELAY_STEP_MS, rangeMs);
}

/** Whole seconds, for labels that state the configured range. */
export function rangeSeconds(rangeMs: number): number {
  return Math.round(rangeMs / 1000);
}
