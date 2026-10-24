/**
 * The numbers and the words the fake copies out of Rust, in one file, with the
 * citation each one carries.
 *
 * They are here rather than beside the command that uses them because nothing
 * but a type is shared across the page-side modules — Playwright serializes each
 * of them on its own, so a constant imported from another file would be a
 * `ReferenceError` in the browser. This script runs first and hangs the bundle on
 * `window`; the core and the command domains take from it what their own bodies
 * name.
 *
 * Keeping them together is also what makes the mirror auditable: a reader who
 * wants to check the fake against the real backend reads this file and nothing
 * else. They belong on this side rather than in the specs because the fake is
 * what has to keep the schedule honest — a spec that invented its own timings
 * would be testing a player that does not exist.
 */

/**
 * Runs **inside the page**, before the core that reads it, and before any app
 * code. Serialized by Playwright, so, like every other page-side script here, it
 * closes over nothing from its module.
 */
export function bridgeConstants(): void {
  // The tone player's numbers, copied from `src-tauri/src/audio/calibration/`
  // with the same names: `TONE_BURST_MS`, `TONE_REPS_*`, `LEAD_MS_*` and
  // `TAIL_MS_*` on the module's own root file, the gap drawn before every burst
  // in `schedule.rs`, and the pump's backstop in `pump.rs`.
  /** `TONE_BURST_MS`: how long one burst sounds. */
  const TONE_BURST_MS = 800;
  /** `TONE_REPS_DEFAULT` / `TONE_REPS_MAX`. */
  const TONE_REPS_DEFAULT = 3;
  const TONE_REPS_MAX = 6;
  /** `LEAD_MS_DEFAULT` and the clamp bounds for caller-supplied lead and tail. */
  const LEAD_MS_DEFAULT = 500;
  const TAIL_MS_DEFAULT = 900;
  const LEAD_MS_MIN = 100;
  const LEAD_MS_MAX = 2000;
  const TAIL_MS_MIN = 100;
  const TAIL_MS_MAX = 2000;
  /** `GAP_MIN_MS` / `GAP_MAX_MS`: the silence drawn before every burst. A fixed
   *  rhythm would let the tapper anticipate the sound and bias the measurement,
   *  which is the whole thing the wizard is measuring. */
  const GAP_MIN_MS = 500;
  const GAP_MAX_MS = 1200;
  /** `WAIT_BACKSTOP_MS`: how long a cancelled run may linger. The real pump
   *  wakes on the device's render event and at worst on this backstop, checking
   *  the cancel flag on both exits; the fake has no render event, so this is the
   *  ceiling on its own wake-ups too. */
  const CANCEL_BACKSTOP_MS = 250;
  /** `NO_RUN_TOKEN`: what a caller that names no run sends — and, unlike a real
   *  token, a number that may repeat, because it names nothing to match. */
  const NO_RUN_TOKEN = 0;
  /** `Refusal::Cancelled::message()` and `Refusal::Busy::message()` —
   *  `src-tauri/src/audio/calibration/state.rs` — word for word:
   *  `isStaleRunMessage` in `src/components/calibration/measure.ts` sorts
   *  one from the other by these strings, so a paraphrase here would test a
   *  wizard that never fires. */
  const SUPERSEDED_MESSAGE = 'calibration superseded (this run was cancelled before it started)';
  const BUSY_MESSAGE = 'a calibration run is already in progress';
  /** `commands::calibration::calibration_start` validates the id before it admits
   *  anything, through `audio::routing::validate_device_id`
   *  (`src-tauri/src/audio/routing/endpoints.rs`), which owns this bound. */
  const MAX_DEVICE_ID_LEN = 1024;
  /** `config::DELAY_MAX_MS`: a magnitude beyond it is refused, not clamped. */
  const DELAY_MAX_MS = 10000;

  window.__AAR_CONSTANTS__ = {
    TONE_BURST_MS,
    TONE_REPS_DEFAULT,
    TONE_REPS_MAX,
    LEAD_MS_DEFAULT,
    TAIL_MS_DEFAULT,
    LEAD_MS_MIN,
    LEAD_MS_MAX,
    TAIL_MS_MIN,
    TAIL_MS_MAX,
    GAP_MIN_MS,
    GAP_MAX_MS,
    CANCEL_BACKSTOP_MS,
    NO_RUN_TOKEN,
    SUPERSEDED_MESSAGE,
    BUSY_MESSAGE,
    MAX_DEVICE_ID_LEN,
    DELAY_MAX_MS,
  };
}
