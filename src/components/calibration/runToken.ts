/** localStorage key holding the highest run token this webview has handed out,
 * next to the aar-theme / aar-language / aar-delay-step keys. */
const RUN_TOKEN_STORAGE_KEY = 'aar-calibration-run';

/** The highest token minted so far by this page; see `mintRunToken`. */
let lastRunToken = 0;

/**
 * The `run` identity of one wizard run — the number both `calibration_start` and
 * `calibration_cancel` carry, and the only thing that tells the player's
 * `begin` which of its two callers arrived first.
 *
 * It has to answer to exactly one run, ever: the player outlives the page, so a
 * token reused by a *later* run — or by a page reloaded over a cancel mark the
 * earlier page left — would either refuse a burst the user never called off or
 * play one they did. `Date.now()` alone does not hold: two runs minted in the
 * same millisecond share a token, and a reload landing inside the previous
 * page's last millisecond hands that token straight back. So every token is the
 * previous one plus one, seeded from the wall clock and left in storage —
 * strictly increasing for this webview across reloads, and below
 * `Number.MAX_SAFE_INTEGER` (so well inside the backend's `u64`) for as long as
 * the epoch is measured in milliseconds.
 */
export function mintRunToken(): number {
  let previous = lastRunToken;
  try {
    const stored = Number(localStorage.getItem(RUN_TOKEN_STORAGE_KEY));
    if (Number.isSafeInteger(stored) && stored > previous) previous = stored;
  } catch {
    /* storage may be unavailable; the wall-clock seed below still applies */
  }
  const next = Math.min(Number.MAX_SAFE_INTEGER, Math.max(previous, Date.now()) + 1);
  lastRunToken = next;
  try {
    localStorage.setItem(RUN_TOKEN_STORAGE_KEY, String(next));
  } catch {
    /* nothing to persist: within this page the counter already holds */
  }
  return next;
}
