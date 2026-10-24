import { mockIPC } from '@tauri-apps/api/mocks';

import type {
  AudioDevice,
  AudioSession,
  FeedOutcome,
  ResetOutcome,
  StopOutcome,
} from '@/lib/types';
import { useRouterStore } from '@/stores/routerStore';

/**
 * The store is where every UI decision about audio is made, so this is the
 * suite that has to hold: routing, undoing a route, an engine dying under a
 * live route, a device unplugged mid-selection, remembered routes coming back.
 *
 * The backend is a scriptable fake installed with `mockIPC` — no Core Audio,
 * no filesystem, no timers beyond the store's own. Failures are injected by
 * command, so the error paths are just as repeatable as the happy ones.
 *
 * This is the scaffolding the suite stands on: one file per domain —
 * `selection`, `apply`, `stop`, `lists`, `memory`, `feeds`, `tuning`, `release` —
 * each named `src/stores/routerStore.<domain>.test.ts`, each importing all of
 * this from here. Nothing in this file is a test: Vitest only collects files
 * whose name ends in `.test.ts`, so this name is never picked up as one.
 */

export const SPEAKERS: AudioDevice = { id: 'speakers', name: 'Speakers' };
export const TV: AudioDevice = { id: 'tv', name: 'TV' };
export const HEADPHONES: AudioDevice = { id: 'headphones', name: 'Headphones' };

export const MUSIC: AudioSession = { pid: 1001, exe_name: 'music.exe' };
export const GAME: AudioSession = { pid: 1002, exe_name: 'game.exe' };

/**
 * The restore tests need their own PID.
 *
 * `autoRestoreDecided` is module-level on purpose — a process that was routed,
 * or that the user stopped by hand, must never be claimed again in this run —
 * so it cannot be cleared between tests. Anything that shares a PID with an
 * earlier test inherits its decision.
 *
 * The scope of that sentence is one test file, not the suite: Vitest gives every
 * file a fresh module registry, so `autoRestoreDecided`, `feedRestoreDecided` and
 * the icon-retry budget all start empty in each `routerStore.*.test.ts`. A PID
 * reused by two *files* therefore inherits nothing — which is safe only because
 * no test may lean on a decision made outside itself. Keep the rule inside the
 * file: a test that needs a pid nobody has decided yet says so by using its own,
 * and a test that needs one already decided drives that decision itself.
 */
export const FRESH_MUSIC: AudioSession = { pid: 3001, exe_name: 'music.exe' };

export interface Backend {
  devices: AudioDevice[];
  sessions: AudioSession[];
  defaultDeviceId: string | null;
  /** pid -> ordered device ids, as the (fake) engine is running them. */
  routes: Record<number, string[]>;
  /** pid -> engine generation, as `apply_route` handed it out. */
  routeGenerations: Record<number, number>;
  remembered: [string, string[]][];
  delays: [string, number][];
  volumes: [string, number][];
  /** The remembered feed rules, as `(source_exe, target_exe)` pairs. */
  feeds: [string, string][];
  /** Running apps with a visible window but no audio session — the feed
   *  picker's second tier, and the pool a silent feed target resolves through. */
  windowApps: AudioSession[];
  /** The loopback pair feeds run through; null halves mean "not configured". */
  carrier: { render: string | null; capture: string | null };
  calls: { cmd: string; args: Record<string, unknown> }[];
  generation: number;
  /** Return true to make a command fail, the way a real backend would. */
  fail: (cmd: string, args: Record<string, unknown>) => boolean;
  /** pid -> what `stop_route` answers for it; anything unstated is a clean
   *  release. Which of its two failures a stop was is the backend's to say —
   *  the UI reading its own route list for the answer is the bug these tests
   *  need to be able to tell apart. */
  stopOutcomes: Record<number, Partial<StopOutcome>>;
  /** What `reset_pinned_endpoints` answers. */
  resetOutcome: ResetOutcome;
  /** When set, the `apply_route` calls made with `remember: false` — the restore
   * pass's own — are held until it resolves, so a test can keep a restored
   * route in the air while the user routes the same program over it. */
  holdRestore: Promise<void> | null;
  /** When set, `set_feed_target` answers no earlier than this resolves: the
   * window in which a feed's own pinning has not been acknowledged yet. */
  holdFeed: Promise<void> | null;
  /** When set, `stop_route` answers no earlier than this resolves — and takes the
   * engine down only when it answers, the way the audio service does. Without
   * that delay every reconciliation asked after the store's optimistic clear
   * would already see an empty engine list, which is the one window the store
   * cannot defend itself against. */
  holdStop: Promise<void> | null;
  /** When set, `clear_route` answers (or refuses, when `fail` says so) no earlier
   * than this resolves: the window in which a refused forget rolls back over a
   * memory the user wrote while it was in the air. */
  holdClear: Promise<void> | null;
  /** When set, `get_active_duplications` answers — from the picture it took at
   * call time — no earlier than this resolves: the window in which a store
   * mutation can land after the ask but before its reply. */
  holdActive: Promise<void> | null;
}

export function installBackend(overrides: Partial<Backend> = {}): Backend {
  const backend: Backend = {
    devices: [SPEAKERS, TV],
    sessions: [MUSIC, GAME],
    defaultDeviceId: 'speakers',
    routes: {},
    routeGenerations: {},
    remembered: [],
    delays: [],
    volumes: [],
    feeds: [],
    windowApps: [],
    carrier: { render: 'speakers', capture: 'cable-out' },
    calls: [],
    generation: 0,
    fail: () => false,
    stopOutcomes: {},
    resetOutcome: { released: 0, still_pinned: [], still_pinned_devices: [] },
    holdRestore: null,
    holdFeed: null,
    holdStop: null,
    holdClear: null,
    holdActive: null,
    ...overrides,
  };

  mockIPC((cmd, rawArgs) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    backend.calls.push({ cmd, args });
    // Window and event plumbing is not what these tests are about; answer it
    // the way a shell that has nothing to say would.
    if (cmd.startsWith('plugin:')) {
      return cmd.endsWith('|listen') ? args.handler : null;
    }
    // `clear_route` answers through its own case so a test can hold the refusal
    // until after a memory written meanwhile; every other command refuses at once.
    if (cmd !== 'clear_route' && backend.fail(cmd, args)) throw new Error(`${cmd} failed`);

    switch (cmd) {
      case 'list_devices':
        return backend.devices;
      case 'list_sessions':
        return backend.sessions;
      case 'get_default_device':
        return backend.devices.find((d) => d.id === backend.defaultDeviceId) ?? backend.devices[0];
      case 'apply_route': {
        const pid = args.pid as number;
        const deviceIds = [...(args.deviceIds as string[])];
        backend.routes[pid] = deviceIds;
        // The real command starts an engine only when there are copies; a
        // single-device route is just the per-app endpoint and reports 0.
        let reply = 0;
        if (deviceIds.length > 1) {
          backend.generation += 1;
          backend.routeGenerations[pid] = backend.generation;
          reply = backend.generation;
        } else {
          delete backend.routeGenerations[pid];
        }
        return backend.holdRestore !== null && args.remember === false
          ? backend.holdRestore.then(() => reply)
          : reply;
      }
      case 'stop_route': {
        const pid = args.pid as number;
        // The engine goes down when the service answers, not when the ask was
        // made: a reconciliation asked while a held stop is in flight still finds
        // the engine running, which is the window the store has to survive.
        const release = () => {
          delete backend.routes[pid];
          delete backend.routeGenerations[pid];
          return {
            released: true,
            pinned_device: null,
            sibling_held: false,
            ...backend.stopOutcomes[pid],
          };
        };
        return backend.holdStop === null ? release() : backend.holdStop.then(release);
      }
      case 'get_active_duplications': {
        // The real command lists *engines*, so single-device routes — which
        // have none — never appear here. The real contract is a parallel array
        // matching deviceIds, and the primary (index 0) reports `null` —
        // Windows plays it itself, there is no stream of ours to measure. Same
        // shape the e2e bridge fakes.
        const reply = Object.entries(backend.routes)
          .filter(([, deviceIds]) => deviceIds.length > 1)
          .map(([pid, deviceIds]) => ({
            pid: Number(pid),
            generation: backend.routeGenerations[Number(pid)] ?? 0,
            deviceIds,
            latencyMs: deviceIds.map((_, index) => (index === 0 ? null : 20)),
          }));
        return backend.holdActive === null ? reply : backend.holdActive.then(() => reply);
      }
      case 'get_remembered_routes':
        return backend.remembered;
      case 'list_capture_devices':
        return [{ id: 'cable-out', name: 'CABLE Output' }];
      case 'get_feed_carrier':
        return backend.carrier;
      case 'set_feed_carrier':
        backend.carrier = {
          render: (args.render as string | null) ?? null,
          capture: (args.capture as string | null) ?? null,
        };
        return null;
      case 'list_feeds':
        return backend.feeds;
      case 'list_window_apps':
        return backend.windowApps;
      case 'set_feed_target': {
        // A feed is delivered by the engine's tap into the carrier, so a device
        // route alongside it changes nothing: the only thing that can stop a
        // delivery is a carrier that is not configured.
        const answer = (): FeedOutcome => {
          const sourceExe = args.sourceExe as string;
          const targetExe = args.targetExe as string;
          if (!backend.feeds.some(([s2, t]) => s2 === sourceExe && t === targetExe)) {
            backend.feeds = [...backend.feeds, [sourceExe, targetExe]];
          }
          return backend.carrier.render === null || backend.carrier.capture === null
            ? { delivered: false, reason: 'no_carrier' }
            : { delivered: true, reason: null };
        };
        return backend.holdFeed === null ? answer() : backend.holdFeed.then(answer);
      }
      case 'remove_feed_target': {
        const source = backend.sessions.find((s2) => s2.pid === args.sourcePid)?.exe_name ?? '';
        const target = backend.sessions.find((s2) => s2.pid === args.targetPid)?.exe_name ?? '';
        backend.feeds = backend.feeds.filter(
          ([s2, t]) =>
            !(
              s2.toLowerCase() === source.toLowerCase() && t.toLowerCase() === target.toLowerCase()
            ),
        );
        return [];
      }
      case 'clear_route': {
        // The real `remove_route` forgets case-insensitively: the memory is keyed
        // by image name, and an image name carries whatever case the launch used.
        const forget = () => {
          if (backend.fail('clear_route', args)) throw new Error('clear_route failed');
          backend.remembered = backend.remembered.filter(
            ([name]) => name.toLowerCase() !== (args.exeName as string).toLowerCase(),
          );
          return null;
        };
        return backend.holdClear === null ? forget() : backend.holdClear.then(forget);
      }
      case 'forget_previous_settings':
        backend.remembered = [];
        backend.feeds = [];
        backend.delays = [];
        backend.volumes = [];
        return null;
      case 'get_device_delays':
        return backend.delays;
      case 'set_device_delay':
        return null;
      case 'get_device_volumes':
        return backend.volumes;
      case 'set_device_volume':
        return null;
      case 'get_source_volumes':
        return [];
      case 'release_stale_routes':
        return [];
      case 'reset_pinned_endpoints':
        return backend.resetOutcome;
      case 'get_close_to_tray':
      case 'get_autostart':
      case 'is_silent_launch':
        return false;
      case 'get_startup_notice':
        return null;
      default:
        return null;
    }
  });

  return backend;
}

type StoreState = ReturnType<typeof useRouterStore.getState>;

/**
 * The store as it was created, captured before any test touches it. Replaying
 * it keeps `reset` honest about the real shape of the state instead of a
 * hand-written copy that silently drifts.
 */
const pristine: StoreState = useRouterStore.getState();

/** Puts the store into a known state; module-level caches are left alone. */
export function reset(overrides: Partial<StoreState> = {}): void {
  useRouterStore.setState({
    ...pristine,
    devices: [],
    sessions: [],
    selectedPids: [],
    selectedDeviceIds: [],
    // A plan a fixture writes is that test's own staging, and staging is what
    // freezes the plan against the route moving underneath it. The derived kind
    // — the one that tracks the route and the system default — is only what
    // `selectProcess` leaves behind.
    deviceSelectionPrefilled: false,
    selectedFeedPids: [],
    feedSelectionPrefilled: false,
    routedPids: {},
    engineGenerations: {},
    deviceLatencyMs: {},
    deviceDelays: {},
    delayStepMs: 10,
    deviceVolumes: {},
    sourceVolumes: {},
    soundingPids: {},
    soundingExes: {},
    rememberedRoutes: [],
    rememberedFeeds: [],
    feeds: {},
    windowApps: [],
    feedCarrier: { render: null, capture: null },
    captureDevices: [],
    defaultDeviceId: null,
    startupNotice: null,
    undoSnapshot: null,
    logs: [],
    applying: false,
    errorNotice: null,
    autoRemember: true,
    closeToTray: false,
    autostart: false,
    ...overrides,
  } as Partial<StoreState>);
}

export const state = () => useRouterStore.getState();
export const lastLog = () => state().logs[state().logs.length - 1];
