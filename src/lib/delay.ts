/** Delay compensation helpers, shared by the delay panel and the settings page. */

/**
 * Step sizes (milliseconds) offered by the settings. 10 ms is the default:
 * finer than that is below what matters for aligning two devices, and the
 * field between the step buttons accepts an exact value for anything else.
 */
export const DELAY_STEP_OPTIONS: readonly number[] = [1, 10, 50, 100, 1000];
export const DEFAULT_DELAY_STEP_MS = 10;
/** Bounds a stored step is accepted within. */
const DELAY_STEP_MIN_MS = 1;
const DELAY_STEP_MAX_MS = 1000;

/** localStorage key holding the preferred step, next to the aar-theme /
 * aar-language keys written by the boot script. */
export const DELAY_STEP_STORAGE_KEY = 'aar-delay-step';

/** Delay ranges (milliseconds, half-range) offered by the settings, and the
 * initial store value until the backend reports the persisted one. */
export const DELAY_RANGE_OPTIONS = [1000, 2000, 5000, 10000] as const;
export const DEFAULT_DELAY_RANGE_MS = 5000;

/** Clamp a step to the accepted bounds, rounded to whole milliseconds. */
export function clampStep(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_DELAY_STEP_MS;
  return Math.min(DELAY_STEP_MAX_MS, Math.max(DELAY_STEP_MIN_MS, Math.round(ms)));
}

/**
 * Read the preferred step from storage, falling back to the default. Any value
 * inside the bounds is honoured, not just the offered presets.
 */
export function readDelayStep(): number {
  try {
    const stored = Number(localStorage.getItem(DELAY_STEP_STORAGE_KEY));
    if (stored > 0) return clampStep(stored);
  } catch {
    /* storage may be unavailable; fall through to the default */
  }
  return DEFAULT_DELAY_STEP_MS;
}

/** Clamp a delay to the configured ± range, rounded to whole milliseconds. */
export function clampDelay(ms: number, rangeMs: number): number {
  const rounded = Math.round(Number.isFinite(ms) ? ms : 0);
  return Math.max(-rangeMs, Math.min(rangeMs, rounded));
}

/**
 * Delay as a signed label: `0`, `+250`, `−2500`.
 *
 * The minus sign is U+2212, not the hyphen the ASCII value carries: at tabular
 * widths a hyphen reads as a stray dash, while the real minus sits on the same
 * axis as the plus on the other side of zero.
 */
export function formatDelaySigned(ms: number): string {
  if (ms === 0) return '0';
  return ms > 0 ? `+${ms}` : `\u2212${Math.abs(ms)}`;
}

/**
 * Next delay when stepping `times` times up or down.
 *
 * The current value is snapped to the step first, so a value left behind by a
 * coarser or finer step lands on the current grid instead of keeping an odd
 * offset.
 */
export function stepDelay(
  ms: number,
  direction: 1 | -1,
  rangeMs: number,
  stepMs: number,
  times = 1,
): number {
  const snapped = Math.round(ms / stepMs) * stepMs;
  return clampDelay(snapped + direction * stepMs * times, rangeMs);
}

/** Whole seconds, for labels that state the configured range. */
export function rangeSeconds(rangeMs: number): number {
  return Math.round(rangeMs / 1000);
}

/** Step size as a label: whole seconds read as seconds, anything else as ms. */
export function formatStep(stepMs: number): string {
  return stepMs >= 1000 && stepMs % 1000 === 0 ? `${stepMs / 1000} s` : `${stepMs} ms`;
}
