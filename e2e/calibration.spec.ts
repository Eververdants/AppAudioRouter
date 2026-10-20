import { expect, test, type Locator, type Page } from '@playwright/test';
import { LATENCY_TARGET_MS } from '../src/lib/types';
import { callsFor, calibrationRuns, calibrationTones, openApp } from './fixtures';
import type { BridgeCalibrationRefusal } from './tauri/bridge';

/**
 * The delay-calibration wizard, measured against the fake tone player.
 *
 * The wizard is the app's one place where a *person* is part of the pipeline:
 * the backend writes a burst into one endpoint, brackets it with two
 * `calibration-tone` markers (`start` on the burst's first frame, `end` on its
 * last), and resolves only once the schedule has been written; the user taps
 * when they hear it, and a device's number is `tap − start`. Everything the two
 * devices share — reaction time, the write-ahead padding, event delivery —
 * cancels in the difference, and that difference is the whole product.
 *
 * So the fake models the player's own rules rather than a friendlier stand-in:
 * one burst per call, the caller's lead and tail clamped to the bounds
 * `calibration.rs` clamps to, a gap drawn from the same span before every burst,
 * a marker pair bracketing exactly `TONE_BURST_MS`, a busy flag that admits one
 * run, and a cancel that makes the in-flight run reject with the player's own
 * words. It also models `CalibrationState::begin`'s two staleness marks — a
 * cancel naming a run refuses that run's start with `"calibration superseded"`,
 * an unnamed one that finds no burst sounding refuses whatever start lands next —
 * and holds the admission gate open so a spec can put a cancel inside the window
 * the run token exists for. Its clock is real, which is what makes this spec slow
 * (~20 s) and honest: there is no way to measure a latency without waiting for
 * one.
 *
 * The ear is scripted, and it lives inside the page for that reason: a tap has
 * to land inside a 900 ms window, and routing it through the test runner would
 * put a variable-sized round trip inside the measurement itself. It subscribes
 * through the same door the app does — a callback id handed to
 * `plugin:event|listen` — and presses the wizard's own button with a real
 * `pointerdown`.
 */

test.describe.configure({ timeout: 180_000 });

/** The device ids the scripted graph names. */
const FAST = 'speakers';
const SLOW = 'tv';
/** `TONE_BURST_MS` in `calibration.rs`: what the two markers bracket. */
const TONE_BURST_MS = 800;
/** `MIN_VALID` in `DelayCalibration.tsx`: readings a device has to collect. */
const READINGS = 3;
/** `MIN_ROUNDS`: every chosen device plays this many rounds before extensions. */
const MIN_ROUNDS = 3;
/** `LEAD_MIN_MS` / `LEAD_SPREAD_MS` and `CALL_TAIL_MS`: the wizard's own numbers. */
const LEAD_MIN_MS = 300;
const LEAD_MAX_MS = 300 + 600;
const CALL_TAIL_MS = 300;
/** The scripted reactions, both well inside the window a tap is scored in
 *  (−150 ms to +900 ms around a burst's `start`). 360 ms apart is more than the
 *  page clock can jitter and more than the engine's base pipeline, so the slower
 *  device is unambiguously the baseline and the other takes a real compensation
 *  rather than a clamped zero. */
const FAST_REACTION_MS = 40;
const SLOW_REACTION_MS = 400;
/** `calibration.tap`: the button the wizard asks the user to press. */
const TAP_LABEL = 'Tap when you hear a tone';

/** One press the scripted ear made, and the marker it answered. */
interface EarTap {
  device: string;
  markerAt: number;
  tapAt: number;
}

declare global {
  interface Window {
    /** What the scripted ear pressed, in the page clock. */
    __AAR_EAR_TAPS__?: EarTap[];
  }
}

/** The wizard, opened from the settings page's delay section. */
async function openWizard(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Calibrate…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Calibrate delays' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Check the two devices this run measures. */
async function pickBothDevices(dialog: Locator): Promise<void> {
  await dialog.getByRole('button', { name: 'Speakers', exact: true }).click();
  await dialog.getByRole('button', { name: 'TV', exact: true }).click();
}

/** The scripted ear's configuration, handed into the page. */
interface EarOptions {
  slow: string;
  fastMs: number;
  slowMs: number;
  tapLabel: string;
}

/**
 * Install the ear: answer every burst's `start` marker with a press of the
 * wizard's own tap button, `fastMs` after it on one device and `slowMs` after it
 * on the other.
 */
async function installEar(page: Page): Promise<void> {
  await page.evaluate(
    (options: EarOptions) => {
      const taps: EarTap[] = [];
      window.__AAR_EAR_TAPS__ = taps;
      const answer = (device: string, markerAt: number, reactionMs: number) => {
        window.setTimeout(() => {
          const button = document.querySelector<HTMLButtonElement>(
            `[aria-label="${options.tapLabel}"]`,
          );
          if (button === null) return;
          const tapAt = performance.now();
          button.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, cancelable: true }),
          );
          taps.push({ device, markerAt, tapAt });
        }, reactionMs);
      };
      const onMarker = (raw: unknown) => {
        const payload = (raw as { payload?: { phase?: string } }).payload;
        // Only the burst's first frame is worth answering: the end marker says the
        // bytes are written, not that there is anything left to hear.
        if (payload?.phase !== 'start') return;
        const runs = window.__AAR__?.calibrationRuns() ?? [];
        const run = runs[runs.length - 1];
        if (run === undefined || run.endedAt !== null) return;
        answer(
          run.device,
          performance.now(),
          run.device === options.slow ? options.slowMs : options.fastMs,
        );
      };
      const id = window.__TAURI_INTERNALS__.transformCallback(onMarker);
      void window.__TAURI_INTERNALS__.invoke('plugin:event|listen', {
        event: 'calibration-tone',
        handler: id,
      });
    },
    {
      slow: SLOW,
      fastMs: FAST_REACTION_MS,
      slowMs: SLOW_REACTION_MS,
      tapLabel: TAP_LABEL,
    } satisfies EarOptions,
  );
}

/** The presses the ear made, read back out of the page. */
async function earTaps(page: Page): Promise<EarTap[]> {
  return page.evaluate(() => window.__AAR_EAR_TAPS__ ?? []);
}

/** The press the other two agree with — the wizard's own `median`. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted[Math.floor(sorted.length / 2)];
  if (middle === undefined) throw new Error('no tap was recorded for that device');
  return middle;
}

test('the wizard measures both devices and writes the compensation between them', async ({
  page,
}) => {
  // A stalled measurement is otherwise unreadable, because the tone player runs
  // on page timers: the one thing that can stop it mid-burst is an uncaught
  // error in the page — in practice a vite full reload landing on top of a
  // running measurement. Say so in the log instead of leaving it as a timeout.
  page.on('pageerror', (error) => {
    console.log('[calibration] uncaught error in the page:', error.message);
  });

  // A stored delay on the slow device, so the wizard's `0` for it is a change the
  // backend is really asked for rather than a no-op the store answers silently.
  await openApp(page, { delays: [[SLOW, 500]] });
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Delay compensation', exact: true }).click();

  // ---- leaving mid-burst stops the sound
  let dialog = await openWizard(page);
  await pickBothDevices(dialog);
  await dialog.getByRole('button', { name: 'Start measuring' }).click();
  await expect(dialog).toContainText(/Calibrating: (Speakers|TV)/);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  // Once, not twice: the unmount must not cancel a run the close already stopped.
  expect(await callsFor(page, 'calibration_cancel')).toHaveLength(1);

  // The real player keeps its busy flag until the pump sees the cancel, and only
  // then writes the outcome down. Wait for that rather than guessing at how long
  // the backstop takes — and with it for the next run not to be refused.
  await page.waitForFunction(() => {
    const runs = window.__AAR__?.calibrationRuns() ?? [];
    const last = runs[runs.length - 1];
    return last !== undefined && last.endedAt !== null;
  });
  const aborted = (await calibrationRuns(page))[0];
  expect(aborted?.cancelled).toBe(true);

  // ---- the measurement itself
  await installEar(page);
  dialog = await openWizard(page);
  await pickBothDevices(dialog);
  await dialog.getByRole('button', { name: 'Start measuring' }).click();

  // A tap is counted, and the screen says so under the button.
  await expect(dialog).toContainText(`${READINGS - 2} / ${READINGS} taps counted`, {
    timeout: 30_000,
  });

  await expect(dialog).toContainText('Aligned on TV', { timeout: 120_000 });

  // The sequence behind that screen: three rounds, both devices in each, one
  // burst per call, the caller's own lead and tail. The count of runs is also
  // the proof that every burst was answered — an extension round only happens
  // while some device is still short of readings.
  const runs = (await calibrationRuns(page)).slice(1);
  expect(runs).toHaveLength(MIN_ROUNDS * 2);
  for (const run of runs) {
    expect(run?.cancelled).toBe(false);
    expect(run?.reps).toBe(1);
    expect(run?.tailMs).toBe(CALL_TAIL_MS);
    expect(run?.leadMs).toBeGreaterThanOrEqual(LEAD_MIN_MS);
    expect(run?.leadMs).toBeLessThan(LEAD_MAX_MS);
    expect([FAST, SLOW]).toContain(run?.device);
  }
  for (let round = 0; round < MIN_ROUNDS; round += 1) {
    const devices = runs.slice(round * 2, round * 2 + 2).map((run) => run?.device);
    expect(new Set(devices).size).toBe(2);
  }

  // Each burst was bracketed by exactly one pair of markers, numbered 0 — one
  // burst per call — and the pair spans the burst. A player that emitted both
  // markers at once, or only one, fails here; so would one that let a second run
  // start while the first was still writing, because the markers would
  // interleave and stop pairing up per run.
  const tones = (await calibrationTones(page)).filter((tone) => tone.run >= 1);
  expect(tones).toHaveLength(runs.length * 2);
  for (const [index, run] of runs.entries()) {
    const pair = tones.filter((tone) => tone.run === index + 1);
    expect(pair.map((tone) => tone.phase)).toEqual(['start', 'end']);
    expect(pair[0]?.index).toBe(0);
    expect(pair[0]?.device).toBe(run?.device);
    const bracket = (pair[1]?.at ?? 0) - (pair[0]?.at ?? 0);
    // A deadline can only be crossed late, and only by a page timer's overshoot.
    expect(bracket).toBeGreaterThanOrEqual(TONE_BURST_MS - 100);
    expect(bracket).toBeLessThanOrEqual(TONE_BURST_MS + 300);
  }

  const taps = await earTaps(page);
  expect(taps).toHaveLength(runs.length);

  // The result screen: the slower device is the baseline and keeps 0, the other
  // is held back by the measured difference minus the engine's base pipeline —
  // the lateness a copy carries anyway. The expected number is computed from the
  // raw presses rather than hardcoded, and the two sides may disagree by a
  // millisecond because each handler reads the clock for itself.
  const offsetOf = (device: string) =>
    median(taps.filter((tap) => tap.device === device).map((tap) => tap.tapAt - tap.markerAt));
  const expected = Math.max(0, Math.round(offsetOf(SLOW) - offsetOf(FAST)) - LATENCY_TARGET_MS);

  const rows = dialog.locator('button[aria-pressed]');
  await expect(rows).toHaveCount(2);
  const baseline = rows.filter({ hasText: 'TV' });
  const copy = rows.filter({ hasText: 'Speakers' });
  await expect(baseline).toHaveAttribute('aria-pressed', 'true');
  await expect(baseline).toContainText('—');
  await expect(copy).toHaveAttribute('aria-pressed', 'false');
  const shownDigits = (await copy.innerText()).match(/\+(\d+) ms/)?.[1];
  expect(shownDigits).toBeDefined();
  const shown = Number(shownDigits);
  expect(Math.abs(shown - expected)).toBeLessThanOrEqual(2);

  // Apply writes the numbers and nothing else: no route is replayed to hand the
  // baseline the primary seat, which is the promise the wizard makes.
  await dialog.getByRole('button', { name: 'Apply & finish' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Calibrate…' })).toBeFocused();

  const written = await callsFor(page, 'set_device_delay');
  expect(written.map((call) => call.args)).toMatchObject([
    { deviceId: SLOW, delayMs: 0 },
    { deviceId: FAST, delayMs: shown },
  ]);
  expect(await callsFor(page, 'apply_route')).toHaveLength(0);

  // `DelayConfig::set`: a 0 leaves no entry behind, so the books hold exactly the
  // one device that had to be held back.
  const persisted = await page.evaluate(() => window.__AAR__?.state.delays ?? []);
  expect(persisted).toEqual([[FAST, shown]]);

  // And the settings page's own rows say what was written — the same numbers,
  // read from the store that asked the backend for them.
  await expect(page.getByLabel('Delay compensation of Speakers in milliseconds')).toHaveValue(
    String(shown),
  );
  await expect(page.getByLabel('Delay compensation of TV in milliseconds')).toHaveValue('0');
});

/** Close the fake player's admission gate, or open it.
 *
 *  `calibration_start` is an async command: its `begin` runs when a runtime
 *  worker polls the body, while the sync `calibration_cancel` is answered the
 *  moment the IPC thread reads it. That hand-off is the only way a cancel can
 *  outrank the start it was pressed against, and one thread cannot cross the two
 *  by itself — so a held start sits between the wizard's `invoke` and the
 *  player's admission until this opens the gate, and the spec says which of the
 *  two landed first instead of racing for it. */
async function holdStarts(page: Page, hold: boolean): Promise<void> {
  await page.evaluate((next) => window.__AAR__?.holdCalibrationStarts(next), hold);
}

/** Starts the player refused, with the words it answered by. */
async function refusalsOf(page: Page): Promise<BridgeCalibrationRefusal[]> {
  return page.evaluate(() => window.__AAR__?.calibrationRefusals() ?? []);
}

/** The `run` the wizard's first start carried, and the one its first cancel
 *  named — the pair the backend tells a stale start apart from a live burst. */
async function startAndCancelTokens(page: Page): Promise<{ start: unknown; cancel: unknown }> {
  const starts = await callsFor(page, 'calibration_start');
  const cancels = await callsFor(page, 'calibration_cancel');
  return { start: starts[0]?.args.run, cancel: cancels[0]?.args.run };
}

test('a start that lands after the wizard cancelled is refused, and the wizard starts over', async ({
  page,
}) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Delay compensation', exact: true }).click();
  const dialog = await openWizard(page);
  await pickBothDevices(dialog);

  // The burst is asked for and not yet admitted: this is the window in which the
  // user's 取消 reaches the player *first*.
  await holdStarts(page, true);
  await dialog.getByRole('button', { name: 'Start measuring' }).click();
  await expect(dialog).toContainText(/Calibrating: (Speakers|TV)/);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

  // The cancel named the run its start carries — that is all `begin` has to go
  // on, and the only thing that keeps a later run's first burst playable.
  const { start, cancel } = await startAndCancelTokens(page);
  expect(typeof start).toBe('number');
  expect(start).toBeGreaterThan(0);
  expect(cancel).toBe(start);

  // Nothing was admitted while the gate stood shut, so the 取消 found a silent
  // player, and the start it was pressed against is the one now landing.
  await holdStarts(page, false);
  const refused = await refusalsOf(page);
  expect(refused).toHaveLength(1);
  expect(refused[0]?.token).toBe(start);
  // The player's own words, which is what the wizard sorts its stale paths by.
  expect(refused[0]?.message).toContain('calibration superseded');
  // A refused start takes nothing: no run, no marker, no sound to be missed.
  expect(await calibrationRuns(page)).toHaveLength(0);
  expect(await calibrationTones(page)).toHaveLength(0);

  // The wizard does not report a stop it ordered: the loop is already stale, so
  // the refusal never becomes the failure panel and never reaches the toast.
  await expect(dialog).not.toContainText('Measuring failed');
  await expect(page.getByRole('alert')).toHaveCount(0);

  // And it is not stuck: the screen is back on the selection, where 开始测量 is
  // pressable, and the refusal spent the mark it was aimed at — a new run names
  // a new token, and its burst is admitted and played.
  await expect(dialog.getByRole('button', { name: 'Start measuring' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Start measuring' }).click();
  await page.waitForFunction(() => (window.__AAR__?.calibrationRuns() ?? []).length > 0);
  const runs = await calibrationRuns(page);
  expect(runs).toHaveLength(1);
  expect(runs[0]?.token).not.toBe(start);
  expect(runs[0]?.cancelled).toBe(false);
  await page.waitForFunction(() => (window.__AAR__?.calibrationTones() ?? []).length > 0);
  expect(await refusalsOf(page)).toHaveLength(1);
});

test('a refusal nobody in the wizard asked for is no error card, and its mark is spent', async ({
  page,
}) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Delay compensation', exact: true }).click();
  const dialog = await openWizard(page);
  await pickBothDevices(dialog);

  await holdStarts(page, true);
  await dialog.getByRole('button', { name: 'Start measuring' }).click();
  await expect(dialog).toContainText(/Calibrating: (Speakers|TV)/);

  // The shell's own stop — `main.rs`'s window teardown, which reaches
  // `CalibrationState::cancel` with no run to name and finds the player silent.
  // Nothing in the wizard knows about it: its loop is still the current one.
  await page.evaluate(() => void window.__TAURI_INTERNALS__.invoke('calibration_cancel', {}));
  const { start, cancel } = await startAndCancelTokens(page);
  expect(start).toBeGreaterThan(0);
  // The only cancel so far is the shell's, and it names no run.
  expect(cancel).toBeUndefined();

  await holdStarts(page, false);
  const refused = await refusalsOf(page);
  expect(refused).toHaveLength(1);
  // The coarse rule answers for the one start a cancel over a silent player can
  // only have been aiming at, and says it in the same words.
  expect(refused[0]?.token).toBe(start);
  expect(refused[0]?.message).toContain('calibration superseded');
  expect(await calibrationRuns(page)).toHaveLength(0);

  // A stop the loop did not order is not a measurement that failed: the wizard
  // says nothing, and hands the screen back rather than freezing on a burst that
  // will never sound.
  await expect(dialog).not.toContainText('Measuring failed');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Start measuring' })).toBeEnabled();

  // The mark is spent by that one refusal, so the next run plays — and the gate
  // that measures is open again, which is what lets it.
  await dialog.getByRole('button', { name: 'Start measuring' }).click();
  await page.waitForFunction(() => (window.__AAR__?.calibrationTones() ?? []).length > 0);
  const runs = await calibrationRuns(page);
  expect(runs).toHaveLength(1);
  expect(runs[0]?.token).not.toBe(start);
  expect(runs[0]?.cancelled).toBe(false);
  expect(await refusalsOf(page)).toHaveLength(1);
});
