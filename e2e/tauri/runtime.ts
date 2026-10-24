import type {
  BridgeBoot,
  BridgeCalibrationBooks,
  BridgeDevice,
  BridgeSession,
  BridgeState,
  CommandHandler,
} from './types';

/**
 * The page-side core of the fake runtime: the books every command writes into,
 * the event plumbing the app listens through, and the dispatcher that answers a
 * command by looking it up in the handlers the domain modules registered.
 *
 * It is the only init script that creates anything. The command bodies live one
 * file per domain, mirroring `src-tauri/src/commands/`, and each of those reaches
 * these books through `window.__AAR_BRIDGE__` — the one door that survives
 * serialization, because Playwright sends every page-side function to the browser
 * as its own source text.
 */

/**
 * Runs **inside the page**, before any app code.
 *
 * Serialized by Playwright, so it must not close over anything from the module:
 * `initial` is its only input, and every handle it leaves behind hangs off
 * `window`. The same rule holds for every command domain installed after it.
 */
export function bridgeCore(initial: BridgeState): void {
  /** `NO_RUN_TOKEN`: the value both of the tone player's staleness marks start
   *  at, before any cancel has aimed either one. The name and the rules that read
   *  it live with the player in `./calibration.ts`. */
  const { NO_RUN_TOKEN } = window.__AAR_CONSTANTS__;

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
      runs: [] as BridgeCalibrationBooks['runs'],
      tones: [] as BridgeCalibrationBooks['tones'],
      refusals: [] as BridgeCalibrationBooks['refusals'],
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
    } as BridgeCalibrationBooks,
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

  const handlers = new Map<string, CommandHandler>();

  const invoke = (cmd: string, args: Record<string, unknown> | undefined): unknown => {
    const payload = args ?? {};
    state.calls.push({ cmd, args: payload });
    if (state.failing.includes(cmd)) throw new Error(`${cmd} failed (injected)`);
    // The command's own answer is registered by the domain its body belongs to.
    // Recording the call and honouring `failing` happen here, ahead of every
    // handler, so an injected refusal reads the same whichever file the body
    // lives in; a command nobody claimed — a window control, the clipboard,
    // anything else the shell offers — is answered with nothing rather than with
    // an error the UI would have to survive.
    const handler = handlers.get(cmd);
    if (handler !== undefined) return handler(payload);
    return null;
  };

  // The fake's own event plumbing: what the app subscribes through, and the one
  // window property the frontend asks about before it reveals itself.
  handlers.set('plugin:event|listen', (payload) => {
    const event = String(payload.event);
    const id = Number(payload.handler);
    const existing = listeners.get(event) ?? [];
    existing.push(id);
    listeners.set(event, existing);
    return id;
  });
  handlers.set('plugin:event|unlisten', (payload) => {
    const event = String(payload.event);
    const id = Number(payload.eventId);
    listeners.set(
      event,
      (listeners.get(event) ?? []).filter((entry) => entry !== id),
    );
    return null;
  });
  handlers.set('plugin:window|is_visible', () => {
    // The window is created hidden; the frontend reveals it once painted.
    return false;
  });

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

  /** The door every command domain installed after this one comes through. There
   *  is no other way for them to share these books: nothing but a type is
   *  imported across those files, and nothing but `window` is shared between init
   *  scripts. */
  const boot: BridgeBoot = { state, handlers, deliver };
  window.__AAR_BRIDGE__ = boot;

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
