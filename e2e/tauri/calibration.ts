import type { BridgeCalibrationRun, BridgeDevice } from './types';

/**
 * The delay wizard's test tone: one run at a time, admitted by a `begin` that
 * answers with the player's own refusal, and cancellable while it is still in the
 * queue. Mirrors `src-tauri/src/commands/calibration.rs` over the player in
 * `src-tauri/src/audio/calibration/`.
 *
 * The numbers it keeps honest are in `./constants.ts` with their citations, and
 * the books they are written into are the core's — this module is what plays them.
 *
 * Runs **inside the page**, after the core, and closes over nothing from this
 * module: the books and the event door come off `window.__AAR_BRIDGE__`, the
 * mirrored numbers off `window.__AAR_CONSTANTS__`.
 */
export function registerCalibrationCommands(): void {
  const { state, handlers, deliver } = window.__AAR_BRIDGE__;

  const {
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
  } = window.__AAR_CONSTANTS__;

  const clampInt = (raw: unknown, fallback: number, min: number, max: number): number => {
    const value = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : fallback;
    return Math.min(max, Math.max(min, value));
  };

  /** `commands::calibration::calibration_start`'s `run.unwrap_or(NO_RUN_TOKEN)`: a
   *  caller that names no run sends nothing, and nothing is what the player's
   *  coarser rule answers to. */
  const runTokenOf = (raw: unknown): number =>
    typeof raw === 'number' && Number.isFinite(raw)
      ? Math.max(NO_RUN_TOKEN, Math.trunc(raw))
      : NO_RUN_TOKEN;

  /**
   * `CalibrationState::begin(run)`: admit one run, or say why it cannot start.
   *
   * The order is the player's, and every branch of it matters to a spec: the mark
   * aimed at *this* run first, then the mark an unnamed cancel left for whoever
   * comes next, then the busy flag — and a refusal spends only the mark it was
   * aimed at, so a start that collides with a burst still sounding leaves another
   * run's mark standing, and takes nothing itself.
   */
  const beginCalibrationRun = (token: number): string | null => {
    const books = state.calibration;
    if (token !== NO_RUN_TOKEN && books.cancelledRun === token) {
      books.cancelledRun = NO_RUN_TOKEN;
      return SUPERSEDED_MESSAGE;
    }
    if (books.staleGeneration !== NO_RUN_TOKEN) {
      books.staleGeneration = NO_RUN_TOKEN;
      return SUPERSEDED_MESSAGE;
    }
    if (books.busy) return BUSY_MESSAGE;
    books.busy = true;
    return null;
  };

  /**
   * Admit one tone run and play its schedule, resolving when it is done.
   *
   * This is `calibration::play_test_tone`'s shape, not a friendlier stand-in:
   * the id is validated first, then `begin` admits one run at a time, then the
   * schedule is silence-lead, and per burst a drawn gap, the burst, and a tail —
   * with `start` riding on the burst's first frame and `end` on its last, and
   * the promise kept until the whole schedule has been written. The fake has no
   * speaker, so a tap is the ear: what the markers say is exactly what the real
   * player says about the bytes it wrote.
   */
  const admitCalibration = (payload: Record<string, unknown>): Promise<void> => {
    const books = state.calibration;
    const device = typeof payload.deviceId === 'string' ? payload.deviceId : '';
    if (device.length === 0) return Promise.reject(new Error('empty device id'));
    if (device.length > MAX_DEVICE_ID_LEN) return Promise.reject(new Error('device id too long'));
    // The next thing the real command does is `GetDevice`, which fails for an
    // endpoint the machine does not have.
    if (!state.devices.some((d: BridgeDevice) => d.id === device)) {
      return Promise.reject(new Error('GetDevice failed: element not found (injected)'));
    }
    const token = runTokenOf(payload.run);
    const refusal = beginCalibrationRun(token);
    if (refusal !== null) {
      // The real command writes one info line and returns the message: a refused
      // start never took the slot, so it leaves no run and no marker behind.
      books.refusals.push({ token, message: refusal, at: performance.now() });
      return Promise.reject(new Error(refusal));
    }

    const reps = clampInt(payload.reps, TONE_REPS_DEFAULT, 1, TONE_REPS_MAX);
    const leadMs = clampInt(payload.leadMs, LEAD_MS_DEFAULT, LEAD_MS_MIN, LEAD_MS_MAX);
    const tailMs = clampInt(payload.tailMs, TAIL_MS_DEFAULT, TAIL_MS_MIN, TAIL_MS_MAX);

    // Marker deadlines, in ms from the run's start: every burst is bracketed by
    // a pair, and the run ends after the last tail.
    const markers: { at: number; index: number; phase: 'start' | 'end' }[] = [];
    let cursor = leadMs;
    for (let rep = 0; rep < reps; rep += 1) {
      cursor += GAP_MIN_MS + Math.floor(Math.random() * (GAP_MAX_MS - GAP_MIN_MS + 1));
      markers.push({ at: cursor, index: rep, phase: 'start' });
      cursor += TONE_BURST_MS;
      markers.push({ at: cursor, index: rep, phase: 'end' });
      cursor += tailMs;
    }
    const totalMs = cursor;

    const run: BridgeCalibrationRun = {
      device,
      token,
      reps,
      leadMs,
      tailMs,
      startedAt: performance.now(),
      endedAt: null,
      cancelled: false,
    };
    const runIndex = books.runs.push(run) - 1;
    // `begin` clears the cancel flag for a fresh run — a flag that outlived its
    // run would fail every later one at once. A per-run flag gets that for free,
    // and `begin` already took the busy flag: a refusal took nothing.
    const active = { cancelRequested: false };
    books.active = active;

    return new Promise<void>((resolve, reject) => {
      let next = 0;
      let timer = 0;
      const finish = (cancelled: boolean) => {
        window.clearTimeout(timer);
        books.busy = false;
        if (books.active === active) books.active = null;
        run.endedAt = performance.now();
        run.cancelled = cancelled;
      };
      const tick = () => {
        if (active.cancelRequested) {
          // The real pump returns `Api("calibration cancelled")` from the same
          // check, and the wizard reads that string as its own doing.
          finish(true);
          reject(new Error('calibration cancelled'));
          return;
        }
        const elapsed = performance.now() - run.startedAt;
        while (next < markers.length && elapsed >= (markers[next] as { at: number }).at) {
          const marker = markers[next] as { at: number; index: number; phase: 'start' | 'end' };
          books.tones.push({
            run: runIndex,
            device,
            index: marker.index,
            phase: marker.phase,
            at: performance.now(),
          });
          // `let _ = app.emit(...)`: the player writes bytes and cannot be
          // disturbed by whoever in the webview failed to handle the marker. A
          // throw that reached this loop would strand the run — the burst would
          // never resolve, and the wizard would sit on the measure screen with
          // neither a sound nor an error to explain it.
          try {
            deliver('calibration-tone', { index: marker.index, phase: marker.phase });
          } catch (error) {
            console.error('[calibration] a tone subscriber failed', error);
          }
          next += 1;
        }
        if (next >= markers.length && elapsed >= totalMs) {
          finish(false);
          resolve();
          return;
        }
        const waitTo =
          next < markers.length
            ? (markers[next] as { at: number }).at - elapsed
            : totalMs - elapsed;
        timer = window.setTimeout(tick, Math.max(1, Math.min(waitTo, CANCEL_BACKSTOP_MS)));
      };
      tick();
    });
  };

  /**
   * `calibration_start` as the page sees it: the command is answered by the
   * player's admission, and a held player has not got round to it yet.
   *
   * The real command is `async`: `state.begin(run)` runs when a runtime worker
   * polls the body, while the sync `calibration_cancel` is answered the moment
   * the IPC thread reads it — which is how a cancel can outrank the very start it
   * was pressed against, the race the run token exists to close. One thread
   * cannot cross the two by itself, so while the gate is held a start waits here
   * exactly where the real one waits in the queue: sent, not admitted.
   */
  const startCalibration = (payload: Record<string, unknown>): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const admit = () => {
        admitCalibration(payload).then(resolve, reject);
      };
      if (state.calibration.held) {
        state.calibration.queue.push(admit);
        return;
      }
      admit();
    });

  handlers.set('calibration_start', (payload) => startCalibration(payload));
  handlers.set('calibration_cancel', (payload) => {
    // `CalibrationState::cancel(run)`. The flag always reaches the burst that
    // is sounding, and it only ends *that* run — `begin` would clear it for
    // the next one, so a per-run flag gets the same outcome for free. What the
    // run decides is what may still *begin*: a named cancel records the run it
    // aimed at (precise: only a start of that run is refused), and an unnamed
    // one that finds nothing admitted can only have been answering a start
    // still in the queue, so it marks the generation and the next start to
    // land eats the refusal. The mark is spent by that one refusal, so no run
    // is refused twice for a stop nobody asked for.
    const books = state.calibration;
    const token = runTokenOf(payload.run);
    books.cancelGeneration += 1;
    if (token === NO_RUN_TOKEN) {
      if (!books.busy) books.staleGeneration = books.cancelGeneration;
    } else {
      books.cancelledRun = token;
    }
    if (books.active !== null) books.active.cancelRequested = true;
    return null;
  });
}
