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
  /** The loopback pair feeds are carried through; null halves mean "none set". */
  feedCarrier: { render: string | null; capture: string | null };
  /** `(source_exe, target_exe)` — the remembered feed rules. */
  feeds: [string, string][];
}

/** Commands the fake backend should reject, by name. */
export type FailingCommands = string[];

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
  /** Forget the recorded calls, so a later assertion sees only new ones. */
  resetCalls: () => void;
}

declare global {
  interface Window {
    __AAR__?: BridgeHandle & { state: BridgeState & Record<string, unknown> };
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
  const state = {
    ...initial,
    routes: {} as Record<string, string[]>,
    calls: [] as { cmd: string; args: Record<string, unknown> }[],
    generation: 0,
    failing: [] as string[],
  };
  const callbacks = new Map<number, (data: unknown) => void>();
  const listeners = new Map<string, number[]>();
  let nextCallbackId = 1;

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
          state.devices.find((d: BridgeDevice) => d.id === state.defaultDeviceId) ?? state.devices[0]
        );
      case 'apply_route':
        state.routes[String(payload.pid)] = [...(payload.deviceIds as string[])];
        state.generation += 1;
        return state.generation;
      case 'stop_route':
        delete state.routes[String(payload.pid)];
        return { released: true, pinned_device: null };
      case 'get_active_duplications':
        return Object.entries(state.routes).map(([pid, deviceIds]) => ({
          pid: Number(pid),
          generation: 1,
          deviceIds,
          latencyMs: (deviceIds as string[]).map(() => 20),
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
      case 'set_feed_target': {
        const sourceExe = payload.sourceExe as string;
        const targetExe = payload.targetExe as string;
        if (!state.feeds.some(([s, t]: [string, string]) => s === sourceExe && t === targetExe)) {
          state.feeds = [...state.feeds, [sourceExe, targetExe]];
        }
        // The fake delivers every rule once a pair is configured; the blocked
        // cases (no carrier, a routed source) are driven by the state itself.
        const configured =
          state.feedCarrier.render !== null && state.feedCarrier.capture !== null;
        if (!configured) return { delivered: false, reason: 'no_carrier' };
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
        state.remembered = state.remembered.filter(([name]: [string, string[]]) => name !== payload.exeName);
        return null;
      case 'get_device_delays':
        return state.delays;
      case 'set_device_delay':
        return null;
      case 'get_delay_range':
        return 5000;
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
      case 'set_source_volume':
      case 'align_source_levels':
      case 'set_tray_labels':
      case 'ack_startup_notice':
      case 'set_autostart':
      case 'set_close_to_tray':
        return null;
      case 'release_stale_routes':
        return [];
      case 'reset_pinned_endpoints':
        return { released: 0, still_pinned: [] };
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
        listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== id));
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
  } as unknown as typeof window.__TAURI_INTERNALS__;

  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener() {},
  } as unknown as typeof window.__TAURI_EVENT_PLUGIN_INTERNALS__;

  window.__AAR__ = {
    state: state as unknown as BridgeState & Record<string, unknown>,
    calls: () => state.calls,
    callsFor: (cmd: string) => state.calls.filter((call) => call.cmd === cmd),
    emit: (event: string, payload: unknown) => {
      for (const id of listeners.get(event) ?? []) {
        callbacks.get(id)?.({ event, id: 0, payload });
      }
    },
    setSessions: (sessions: BridgeSession[]) => {
      state.sessions = sessions;
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
  };
}

/** Installs the fake runtime into every page this context opens. */
export async function installBridge(page: Page, state: BridgeState): Promise<void> {
  // The liveness gate reads `document.hasFocus()`, which in a headless browser
  // belongs to whichever parallel worker last held focus — a coin flip unrelated
  // to what a spec asserts. The gate's three conditions stay the app's business;
  // here the focus half is pinned so the flow tests only depend on the events
  // they themselves emit.
  await page.addInitScript(() => {
    Object.defineProperty(document, 'hasFocus', { value: () => true });
  });
  await page.addInitScript(tauriBridge, state);
}

/** The default graph the specs start from: two devices, two apps playing. */
export const DEFAULT_STATE: BridgeState = {
  devices: [
    { id: 'speakers', name: 'Speakers' },
    { id: 'tv', name: 'TV' },
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
  feedCarrier: { render: 'speakers', capture: 'cable-out' },
  feeds: [],
};
