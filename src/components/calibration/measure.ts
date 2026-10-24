/** Median of a non-empty list — the press the others agree with. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted[mid] ?? sorted[0] ?? 0;
}

/**
 * A burst the backend stopped *under* the wizard rather than because this loop
 * asked it to: the window went invisible and its cancellation reached the run
 * before the loop did, or a newer generation refused this start outright.
 *
 * A stop the loop itself ordered never reaches the caller that reads this — it
 * bumps `runId` first, so the run is already stale and stands down at the guard
 * before it. So a message landing here while the loop is still the current one
 * is a run nobody in the wizard meant to end: it is not a measurement worth a
 * failure panel, but the dialog must not freeze on the measure screen either.
 * The two strings are the backend's own (`calibration.rs` answers a burst it
 * stopped mid-run with `"calibration cancelled"`, and `Refusal::Cancelled` — a
 * start whose run the user had already called off — with
 * `"calibration superseded (…)"`).
 */
export function isStaleRunMessage(message: string): boolean {
  return message.includes('calibration cancelled') || message.includes('calibration superseded');
}

/** Fisher–Yates on a copy: the round order rotates so no device is always
 * first, and reaction drift cannot settle on one of them. */
export function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
}
