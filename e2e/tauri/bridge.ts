import type { Page } from '@playwright/test';

/**
 * A fake Tauri runtime for the end-to-end tests.
 *
 * The app is a Tauri window: it talks to Rust through `window.__TAURI_INTERNALS__`
 * and never through HTTP. Rather than start a real backend — which would mean
 * Core Audio, real devices and a Windows-only run — this installs the same
 * surface with a scripted audio graph behind it, before any app code runs.
 *
 * Everything the tests assert on is therefore reproducible: devices, processes,
 * remembered routes and failures are all set by the test, and every command the
 * frontend sends is recorded so a test can check what the UI actually asked for.
 */

export interface BridgeDevice {
  id: string;
  name: string;
}

export interface BridgeSession {
  pid: number;
  exe_name: string;
  /** How the process names itself to a person — its window title or version
   *  description. Absent reads as "no display name", the way a backend that
   *  found no window and no description would report it. */
  display_name?: string;
  /** Whether the session was rendering audio when enumerated; absent reads as
   *  "not sounding". */
  playing?: boolean;
}

export interface BridgeState {
  devices: BridgeDevice[];
  sessions: BridgeSession[];
  defaultDeviceId: string;
  remembered: [string, string[]][];
  delays: [string, number][];
  volumes: [string, number][];
  /** `(exe_name, percent)` — the per-program levels the store reads at boot. */
  sourceVolumes: [string, number][];
  /** `(exe_name, percent)` — the per-program primary (session) volumes. */
  primaryVolumes: [string, number][];
  /** Recording endpoints, for the settings page's carrier picker. */
  captureDevices: BridgeDevice[];
  /** Commands that refuse from the very first call, so a boot-time failure is
   *  reachable without a round-trip through `setFailing` after the app loaded. */
  failing?: string[];
  /** The loopback pair feeds are carried through; null halves mean "none set". */
  feedCarrier: { render: string | null; capture: string | null };
  /** `(source_exe, target_exe)` — the remembered feed rules. */
  feeds: [string, string][];
  /** Running apps with a visible window but no audio session — the feed
   *  picker's second tier, answered by `list_window_apps`. */
  windowApps: BridgeSession[];
}

/** Commands the fake backend should reject, by name. */
export type FailingCommands = string[];

/** One admitted run of the delay wizard's tone player, as
 *  `commands::calibration_start` admits it: the parameters after
 *  `audio::calibration`'s own clamps, and how the run ended. */
export interface BridgeCalibrationRun {
  /** The endpoint the burst was written to — the command's own argument. */
  device: string;
  /** The `run` token it was admitted under; `NO_RUN_TOKEN` when the caller
   *  named none. */
  token: number;
  reps: number;
  leadMs: number;
  tailMs: number;
  /** Page-clock instant the run was admitted. */
  startedAt: number;
  /** Null while it is still playing. */
  endedAt: number | null;
  /** Ended because `calibration_cancel` was asked to. */
  cancelled: boolean;
}

/** One start the tone player refused, with the words it answered by — the log
 *  line `commands::calibration_start` writes for a run the user had already
 *  called off, which is the only place a spec can see the crossing. */
export interface BridgeCalibrationRefusal {
  token: number;
  message: string;
  at: number;
}

/** One `calibration-tone` marker the player emitted, with the run it belongs
 *  to. The event's own payload stays `{ index, phase }`: only one run is ever
 *  alive, so the real backend never names a device in it. */
export interface BridgeToneMarker {
  run: number;
  device: string;
  index: number;
  phase: 'start' | 'end';
  at: number;
}

/** What the page exposes for a test to read and drive. */
export interface BridgeHandle {
  /** Every command the frontend sent, in order. */
  calls: () => { cmd: string; args: Record<string, unknown> }[];
  /** The subset for one command, e.g. `callsFor('apply_route')`. */
  callsFor: (cmd: string) => { cmd: string; args: Record<string, unknown> }[];
  /** Push a backend event the way the Rust notification thread would. */
  emit: (event: string, payload: unknown) => void;
  setSessions: (sessions: BridgeSession[]) => void;
  setDevices: (devices: BridgeDevice[]) => void;
  setFailing: (commands: FailingCommands) => void;
  /** Say whether the window holds the OS focus, the way the shell would, and
   *  hand the app the matching event. */
  setFocused: (focused: boolean) => void;
  /** Forget the recorded calls, so a later assertion sees only new ones. */
  resetCalls: () => void;
  /** Every calibration run the tone player admitted, in order. */
  calibrationRuns: () => BridgeCalibrationRun[];
  /** Every `calibration-tone` marker it played, with its page-clock instant. */
  calibrationTones: () => BridgeToneMarker[];
  /** Every `calibration_start` the tone player refused, in order. */
  calibrationRefusals: () => BridgeCalibrationRefusal[];
  /** Hold the tone player's admission queue open, or drain it.
   *
   *  `calibration_start` is an async command: its body — the `begin` that admits
   *  the run — is polled on a runtime worker, while the sync `calibration_cancel`
   *  is answered at once. That hand-off is the whole reason a run token exists: a
   *  cancel can be handled before the start it was pressed against has been
   *  admitted. One thread cannot cross the two on its own, so a held start sits
   *  between the wizard's `invoke` and the player's `begin` until the spec opens
   *  the gate — the state the real backend is in while the command is in flight. */
  holdCalibrationStarts: (hold: boolean) => void;
}

/** The IPC surface `@tauri-apps/api/core` looks for on the global. The package
 *  ships no type for it — the unit tests reach it through `unknown` — so the
 *  fake declares the members it fills in, and its own assignment is checked. */
interface TauriInternals {
  metadata: {
    currentWindow: { label: string };
    currentWebview: { windowLabel: string; label: string };
  };
  invoke: (cmd: string, args: Record<string, unknown> | undefined) => unknown;
  transformCallback: (callback: (data: unknown) => void) => number;
  unregisterCallback: (id: number) => void;
  runCallback: (id: number, data: unknown) => void;
  callbacks: Map<number, (data: unknown) => void>;
  convertFileSrc: (path: string) => string;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__: TauriInternals;
    __AAR__?: BridgeHandle & { state: BridgeState & Record<string, unknown> };
    /** The shell's answer to `document.hasFocus()`, pinned so a spec does not
     *  depend on which parallel worker happened to hold focus. `setFocused`
     *  moves it for the specs that are about the gate itself. */
    __AAR_WINDOW_FOCUSED__?: boolean;
  }
}

/**
 * Runs **inside the page**, before any app code.
 *
 * Serialized by Playwright, so it must not close over anything from the module:
 * `initial` is its only input, and every handle it leaves behind hangs off
 * `window`.
 */
function tauriBridge(initial: BridgeState): void {
  // The tone player's numbers, copied from `src-tauri/src/audio/calibration.rs`
  // with the same names. They belong here rather than in the specs because the
  // fake is what has to keep the schedule honest — a spec that invented its own
  // timings would be testing a player that does not exist.
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
  /** `Refusal::Cancelled::message()` and `Refusal::Busy::message()`, word for
   *  word: `isStaleRunMessage` in `src/components/calibration/measure.ts` sorts
   *  one from the other by these strings, so a paraphrase here would test a
   *  wizard that never fires. */
  const SUPERSEDED_MESSAGE = 'calibration superseded (this run was cancelled before it started)';
  const BUSY_MESSAGE = 'a calibration run is already in progress';
  /** `commands::calibration_start` validates the id before it admits anything. */
  const MAX_DEVICE_ID_LEN = 1024;
  /** `config::DELAY_MAX_MS`: a magnitude beyond it is refused, not clamped. */
  const DELAY_MAX_MS = 10000;

  const state = {
    ...initial,
    routes: {} as Record<string, string[]>,
    /** Per-route engine generation, as `apply_route` handed it out. */
    routeGenerations: {} as Record<string, number>,
    /** Which engine generation has reported `duplication-ready`, so its mirrors
     *  have a latency reading to hand back. A fresh engine does not yet — and a
     *  stale ready signal says nothing about the engine that replaced it. */
    readyGenerations: {} as Record<string, number>,
    /** The tone player's books: `CalibrationState`'s busy flag and its two
     *  staleness marks, the runs it admitted, and every marker it played. */
    calibration: {
      runs: [] as BridgeCalibrationRun[],
      tones: [] as BridgeToneMarker[],
      refusals: [] as BridgeCalibrationRefusal[],
      busy: false,
      active: null as { cancelRequested: boolean } | null,
      /** `CalibrationState::cancelled_run`: the run the last named cancel aimed
       *  at, which is the only start that mark may refuse. */
      cancelledRun: NO_RUN_TOKEN,
      /** `CalibrationState::stale_generation`: non-zero while an *unnamed* cancel
       *  that found no burst playing waits for the start it can only have been
       *  answering. */
      staleGeneration: NO_RUN_TOKEN,
      /** `CalibrationState::generation`: how many cancels the player has taken. */
      cancelGeneration: 0,
      /** Starts the worker has not polled yet — see `holdCalibrationStarts`. */
      held: false,
      queue: [] as (() => void)[],
    },
    calls: [] as { cmd: string; args: Record<string, unknown> }[],
    generation: 0,
    failing: [...(initial.failing ?? [])],
  };
  const callbacks = new Map<number, (data: unknown) => void>();
  const listeners = new Map<string, number[]>();
  let nextCallbackId = 1;

  /** Hand an event to everything subscribed to it, the way the notification
   *  thread does. The engine's own ready signal is also the moment its mirrors
   *  have a latency to report, so the scripted graph takes it here — before this
   *  the reading does not exist, and only for the generation that reported. */
  const deliver = (event: string, payload: unknown): void => {
    if (event === 'duplication-ready') {
      const data = (payload ?? {}) as { pid?: unknown; generation?: unknown };
      if (typeof data.pid === 'number' && typeof data.generation === 'number') {
        const pid = String(data.pid);
        if (state.routeGenerations[pid] === data.generation) {
          state.readyGenerations[pid] = data.generation;
        }
      }
    }
    for (const id of listeners.get(event) ?? []) {
      callbacks.get(id)?.({ event, id: 0, payload });
    }
  };

  const clampInt = (raw: unknown, fallback: number, min: number, max: number): number => {
    const value = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : fallback;
    return Math.min(max, Math.max(min, value));
  };

  /** `commands.rs`'s `run.unwrap_or(NO_RUN_TOKEN)`: a caller that names no run
   *  sends nothing, and nothing is what the player's coarser rule answers to. */
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

  const invoke = (cmd: string, args: Record<string, unknown> | undefined): unknown => {
    const payload = args ?? {};
    state.calls.push({ cmd, args: payload });
    if (state.failing.includes(cmd)) throw new Error(`${cmd} failed (injected)`);

    switch (cmd) {
      case 'list_devices':
        return state.devices;
      case 'list_sessions':
        return state.sessions;
      case 'get_process_icon': {
        // A deterministic tile hashed from the executable name, so the specs
        // exercise the real RGBA→data-URL path without binary fixtures. An
        // unknown pid reads as "no icon", the way a dead process would.
        const session = state.sessions.find((s) => s.pid === Number(payload.pid));
        if (session === undefined) return null;
        let hash = 0;
        for (const ch of session.exe_name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
        const rgba = new Uint8ClampedArray(8 * 8 * 4);
        for (let i = 0; i < rgba.length; i += 4) {
          rgba[i] = hash & 0xff;
          rgba[i + 1] = (hash >> 8) & 0xff;
          rgba[i + 2] = (hash >> 16) & 0xff;
          rgba[i + 3] = 255;
        }
        return { width: 8, height: 8, rgba: btoa(String.fromCharCode(...rgba)) };
      }
      case 'get_default_device':
        return (
          state.devices.find((d: BridgeDevice) => d.id === state.defaultDeviceId) ??
          state.devices[0]
        );
      case 'apply_route': {
        const pid = String(payload.pid);
        const deviceIds = [...(payload.deviceIds as string[])];
        state.routes[pid] = deviceIds;
        // The real command starts an engine only when there are copies; a
        // single-device route is just the per-app endpoint and reports 0.
        if (deviceIds.length <= 1) {
          delete state.routeGenerations[pid];
          delete state.readyGenerations[pid];
          return 0;
        }
        state.generation += 1;
        state.routeGenerations[pid] = state.generation;
        // A new engine has not opened its mirrors yet, so it has no reading to
        // report until it says it is ready.
        delete state.readyGenerations[pid];
        return state.generation;
      }
      case 'stop_route':
        delete state.routes[String(payload.pid)];
        delete state.routeGenerations[String(payload.pid)];
        delete state.readyGenerations[String(payload.pid)];
        return { released: true, pinned_device: null, sibling_held: false };
      case 'get_active_duplications':
        // The real command lists *engines*, so single-device routes — which
        // have none — never appear here. Parallel arrays, same order as the
        // real engine reports them: the primary has no stream of ours to ask,
        // so its entry is `null` — the same "not measured" the real backend
        // sends for it, and for the copies too until the engine whose
        // generation reported `duplication-ready` is still the live one.
        return Object.entries(state.routes)
          .filter(([, deviceIds]) => deviceIds.length > 1)
          .map(([pid, deviceIds]) => ({
            pid: Number(pid),
            generation: state.routeGenerations[pid] ?? 0,
            deviceIds,
            latencyMs: deviceIds.map((_, index) =>
              index === 0 || state.readyGenerations[pid] !== state.routeGenerations[pid]
                ? null
                : 20,
            ),
          }));
      case 'get_remembered_routes':
        return state.remembered;
      case 'list_capture_devices':
        return state.captureDevices;
      case 'get_feed_carrier':
        return state.feedCarrier;
      case 'set_feed_carrier':
        state.feedCarrier = {
          render: (payload.render as string | null) ?? null,
          capture: (payload.capture as string | null) ?? null,
        };
        return null;
      case 'list_feeds':
        return state.feeds;
      case 'list_window_apps':
        return state.windowApps;
      case 'set_feed_target': {
        const sourceExe = payload.sourceExe as string;
        const targetExe = payload.targetExe as string;
        if (!state.feeds.some(([s, t]: [string, string]) => s === sourceExe && t === targetExe)) {
          state.feeds = [...state.feeds, [sourceExe, targetExe]];
        }
        const configured = state.feedCarrier.render !== null && state.feedCarrier.capture !== null;
        if (!configured) return { delivered: false, reason: 'no_carrier' };
        // A feed is the engine's tap into the carrier, so a device route
        // alongside it changes nothing: only a missing carrier blocks delivery.
        return { delivered: true, reason: null };
      }
      case 'remove_feed_target': {
        // The real command addresses the two ends by PID (the toggle already
        // knows the sessions); the fake maps back to the exe names its memory
        // is keyed by.
        const sourceExe = state.sessions.find(
          (s: BridgeSession) => s.pid === payload.sourcePid,
        )?.exe_name;
        const targetExe = state.sessions.find(
          (s: BridgeSession) => s.pid === payload.targetPid,
        )?.exe_name;
        state.feeds = state.feeds.filter(
          ([s, t]: [string, string]) =>
            !(
              s.toLowerCase() === (sourceExe ?? '').toLowerCase() &&
              t.toLowerCase() === (targetExe ?? '').toLowerCase()
            ),
        );
        // Nothing stays pinned in the fake: it has no endpoint books.
        return [];
      }
      case 'clear_route':
        state.remembered = state.remembered.filter(
          ([name]: [string, string[]]) => name !== payload.exeName,
        );
        return null;
      case 'get_device_delays':
        return state.delays;
      case 'set_device_delay': {
        const deviceId = String(payload.deviceId);
        const delayMs = Number(payload.delayMs);
        // `DelayConfig::set`: 0 removes the entry, a magnitude past the hard
        // bound is refused rather than clamped, and anything else is persisted
        // so a later boot reads the same number back.
        if (!Number.isFinite(delayMs)) return null;
        if (Math.abs(delayMs) > DELAY_MAX_MS) {
          throw new Error(`delay ${delayMs} ms is outside the supported ±${DELAY_MAX_MS} ms bound`);
        }
        const rest = state.delays.filter(([id]: [string, number]) => id !== deviceId);
        state.delays = delayMs === 0 ? rest : [...rest, [deviceId, delayMs]];
        return null;
      }
      case 'calibration_start':
        return startCalibration(payload);
      case 'calibration_cancel': {
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
      }
      case 'get_device_volumes':
        return state.volumes;
      case 'set_device_volume':
        return null;
      case 'get_primary_volumes':
        return state.primaryVolumes;
      case 'set_primary_volume': {
        const exeName = String(payload.exeName);
        const percent = Number(payload.percent);
        // 100 is the neutral volume and is stored as "no entry", the same rule
        // the real backend follows.
        const rest = state.primaryVolumes.filter(([name]) => name !== exeName);
        state.primaryVolumes = percent === 100 ? rest : [...rest, [exeName, percent]];
        return null;
      }
      case 'get_source_volumes':
        return state.sourceVolumes;
      case 'set_source_volume': {
        const exeName = String(payload.exeName);
        const percent = Number(payload.percent);
        // 100 is the neutral level and is stored as "no entry", the same rule
        // the real backend follows.
        const rest = state.sourceVolumes.filter(([name]) => name !== exeName);
        state.sourceVolumes = percent === 100 ? rest : [...rest, [exeName, percent]];
        return null;
      }
      case 'align_source_levels':
        // The real command answers with what it set, what it walked past and how
        // many routed programs had a reading at all; the store destructures all
        // three, so answering `null` here made every align in e2e take the catch
        // branch and log a failure for an action the fake never performed.
        return { aligned: [], leftAlone: [], playing: 0 };
      case 'set_tray_labels':
      case 'ack_startup_notice':
      case 'set_autostart':
      case 'set_close_to_tray':
        return null;
      case 'release_stale_routes':
        return [];
      case 'reset_pinned_endpoints':
        // Nothing is left pinned in the scripted graph: every stop above
        // releases, and there is no boot-time residue to sweep.
        return { released: 0, still_pinned: [], still_pinned_devices: [] };
      case 'get_close_to_tray':
      case 'get_autostart':
      case 'is_silent_launch':
        return false;
      case 'get_startup_notice':
        return null;
      case 'plugin:event|listen': {
        const event = String(payload.event);
        const id = Number(payload.handler);
        const existing = listeners.get(event) ?? [];
        existing.push(id);
        listeners.set(event, existing);
        return id;
      }
      case 'plugin:event|unlisten': {
        const event = String(payload.event);
        const id = Number(payload.eventId);
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((entry) => entry !== id),
        );
        return null;
      }
      case 'plugin:window|is_visible':
        // The window is created hidden; the frontend reveals it once painted.
        return false;
      default:
        // Window controls, clipboard, anything else the shell offers: answered
        // with nothing rather than with an error the UI would have to survive.
        return null;
    }
  };

  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { windowLabel: 'main', label: 'main' },
    },
    invoke,
    transformCallback(callback: (data: unknown) => void) {
      const id = nextCallbackId;
      nextCallbackId += 1;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback(id: number) {
      callbacks.delete(id);
    },
    runCallback(id: number, data: unknown) {
      callbacks.get(id)?.(data);
    },
    callbacks,
    convertFileSrc: (path: string) => path,
  };

  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener() {},
  } as unknown as typeof window.__TAURI_EVENT_PLUGIN_INTERNALS__;

  window.__AAR__ = {
    state: state as unknown as BridgeState & Record<string, unknown>,
    calls: () => state.calls,
    callsFor: (cmd: string) => state.calls.filter((call) => call.cmd === cmd),
    emit: deliver,
    setSessions: (sessions: BridgeSession[]) => {
      state.sessions = sessions;
    },
    setFocused: (focused: boolean) => {
      // The app's liveness gate re-reads `document.hasFocus()` when the shell
      // says the window gained or lost focus, so this is the window's own
      // blur — not a stub of the hook.
      window.__AAR_WINDOW_FOCUSED__ = focused;
      window.dispatchEvent(new Event(focused ? 'focus' : 'blur'));
    },
    setDevices: (devices: BridgeDevice[]) => {
      state.devices = devices;
    },
    setFailing: (commands: string[]) => {
      state.failing = commands;
    },
    resetCalls: () => {
      state.calls = [];
    },
    calibrationRuns: () => state.calibration.runs,
    calibrationTones: () => state.calibration.tones,
    calibrationRefusals: () => state.calibration.refusals,
    holdCalibrationStarts: (hold: boolean) => {
      const books = state.calibration;
      books.held = hold;
      if (hold) return;
      // Drain in arrival order: the queued commands are polled by the runtime in
      // the order they were sent, and the busy flag admits one of them.
      const waiting = books.queue.splice(0, books.queue.length);
      for (const admit of waiting) admit();
    },
  };
}

/** Installs the fake runtime into every page this context opens. */
export async function installBridge(page: Page, state: BridgeState): Promise<void> {
  // The liveness gate reads `document.hasFocus()`, which in a headless browser
  // belongs to whichever parallel worker last held focus — a coin flip unrelated
  // to what a spec asserts. The gate's three conditions stay the app's business;
  // here the focus half is pinned so the flow tests only depend on the events
  // they themselves emit.
  //
  // The language is pinned for the same reason: the app picks it from
  // `navigator.language`, so every string these specs match on would come out in
  // the machine's own language — a zh-CN box would fail the whole suite on text
  // that has nothing to do with what any of them tests.
  await page.addInitScript(() => {
    window.__AAR_WINDOW_FOCUSED__ = true;
    Object.defineProperty(document, 'hasFocus', {
      value: () => window.__AAR_WINDOW_FOCUSED__ !== false,
    });
    try {
      // Key shared with `src/i18n/index.ts`; unreadable storage (the about:blank
      // this also runs on) just falls back to the system language.
      localStorage.setItem('aar-language', 'en');
    } catch {
      /* nothing to do: the specs then read whatever the box speaks */
    }
  });
  await page.addInitScript(tauriBridge, state);
}

/** The default graph the specs start from: three devices, two apps playing. */
export const DEFAULT_STATE: BridgeState = {
  devices: [
    { id: 'speakers', name: 'Speakers' },
    { id: 'tv', name: 'TV' },
    // The carrier's playback side, enumerated like anything else on the
    // machine: it exists, the settings page can still name it, and the board
    // must not hand it out as a destination.
    { id: 'cable-in', name: 'CABLE Input (VB-Audio Virtual Cable)' },
  ],
  sessions: [
    { pid: 1001, exe_name: 'music.exe' },
    { pid: 1002, exe_name: 'game.exe' },
  ],
  defaultDeviceId: 'speakers',
  remembered: [],
  delays: [],
  volumes: [],
  primaryVolumes: [],
  sourceVolumes: [],
  captureDevices: [{ id: 'cable-out', name: 'CABLE Output' }],
  // Pre-configured so the specs that concern the board's feed behaviour do not
  // have to walk through settings first; the carrier's own specs override it.
  feedCarrier: { render: 'cable-in', capture: 'cable-out' },
  feeds: [],
  windowApps: [],
};
