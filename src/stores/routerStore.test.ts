import { describe, expect, it, vi } from 'vitest';
import { mockIPC } from '@tauri-apps/api/mocks';
import i18next from 'i18next';
import type {
  AudioDevice,
  AudioSession,
  FeedOutcome,
  ResetOutcome,
  StopOutcome,
} from '@/lib/types';
import { feedLiveness, useRouterStore } from './routerStore';

/**
 * The store is where every UI decision about audio is made, so this is the
 * suite that has to hold: routing, undoing a route, an engine dying under a
 * live route, a device unplugged mid-selection, remembered routes coming back.
 *
 * The backend is a scriptable fake installed with `mockIPC` — no Core Audio,
 * no filesystem, no timers beyond the store's own. Failures are injected by
 * command, so the error paths are just as repeatable as the happy ones.
 */

const SPEAKERS: AudioDevice = { id: 'speakers', name: 'Speakers' };
const TV: AudioDevice = { id: 'tv', name: 'TV' };
const HEADPHONES: AudioDevice = { id: 'headphones', name: 'Headphones' };

const MUSIC: AudioSession = { pid: 1001, exe_name: 'music.exe' };
const GAME: AudioSession = { pid: 1002, exe_name: 'game.exe' };

/**
 * The restore tests need their own PID.
 *
 * `autoRestoreDecided` is module-level on purpose — a process that was routed,
 * or that the user stopped by hand, must never be claimed again in this run —
 * so it cannot be cleared between tests. Anything that shares a PID with an
 * earlier test inherits its decision.
 */
const FRESH_MUSIC: AudioSession = { pid: 3001, exe_name: 'music.exe' };

interface Backend {
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

function installBackend(overrides: Partial<Backend> = {}): Backend {
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
function reset(overrides: Partial<StoreState> = {}): void {
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

const state = () => useRouterStore.getState();
const lastLog = () => state().logs[state().logs.length - 1];

describe('process and device selection', () => {
  it('prefills the devices a process is already routed to', () => {
    installBackend();
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC],
      routedPids: { 1001: ['tv'] },
      defaultDeviceId: 'speakers',
    });

    state().selectProcess(1001);

    expect(state().selectedPids).toEqual([1001]);
    expect(state().selectedDeviceIds).toEqual(['tv']);
    expect(state().deviceSelectionPrefilled).toBe(true);
  });

  it('prefills a sibling process from the route its program holds', () => {
    installBackend();
    reset({
      devices: [SPEAKERS, TV],
      sessions: [
        { pid: 2002, exe_name: 'music.exe' },
        { pid: 2001, exe_name: 'music.exe' },
      ],
      routedPids: { 2001: ['tv'] },
      defaultDeviceId: 'speakers',
    });

    // A route is one per executable, written to the lowest pid. Selecting
    // another process of the same program has to read that route back, not the
    // system default the program is not actually playing through.
    state().selectProcess(2002);

    expect(state().selectedPids).toEqual([2002]);
    expect(state().selectedDeviceIds).toEqual(['tv']);
    expect(state().deviceSelectionPrefilled).toBe(true);
  });

  it('falls back to the system default, and to nothing when that device is gone', () => {
    installBackend();
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC, GAME],
      rememberedRoutes: [{ exeName: 'music.exe', deviceIds: ['tv'] }],
      defaultDeviceId: 'speakers',
    });

    // The remembered route is only a target once it has been restored into a
    // live route; until then the process is playing through the system default.
    state().selectProcess(1001);
    expect(state().selectedDeviceIds).toEqual(['speakers']);

    // A default device that is not in the list (unplugged) is not offered.
    reset({
      devices: [TV],
      sessions: [MUSIC],
      defaultDeviceId: 'speakers',
    });
    state().selectProcess(1001);
    expect(state().selectedDeviceIds).toEqual([]);
    // An empty guess still counts as a guess, so the first click replaces it
    // rather than adding to nothing.
    expect(state().deviceSelectionPrefilled).toBe(true);
  });

  it('follows the system default while the plan is still the prefill', async () => {
    const backend = installBackend({ devices: [SPEAKERS, TV] });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC],
      defaultDeviceId: 'speakers',
    });
    state().selectProcess(MUSIC.pid);
    expect(state().selectedDeviceIds).toEqual(['speakers']);

    // The default switches under an unrouted programme — the board says where
    // its sound goes, so it follows without the programme being re-selected.
    backend.defaultDeviceId = 'tv';
    await state().loadDefaultDevice();

    expect(state().selectedDeviceIds).toEqual(['tv']);

    // A plan the user staged is theirs: the default moving under it — the first
    // click replaces the prefill, as ever — leaves the staging alone.
    state().toggleDeviceSelection('speakers');
    state().toggleDeviceSelection('tv');
    expect(state().selectedDeviceIds).toEqual(['speakers', 'tv']);

    backend.defaultDeviceId = 'speakers';
    await state().loadDefaultDevice();

    expect(state().selectedDeviceIds).toEqual(['speakers', 'tv']);
  });

  it('puts a returning device back on the board without a re-selection', async () => {
    // The Bluetooth shape: a programme routed to a headset, the headset gone —
    // the route released, remembered — and back again while the board is still
    // looking at the programme. Only a re-selection used to redraw it.
    const backend = installBackend({ devices: [SPEAKERS, TV] });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC],
      selectedPids: [MUSIC.pid],
      selectedDeviceIds: ['tv'],
      routedPids: { [MUSIC.pid]: ['tv'] },
      engineGenerations: { [MUSIC.pid]: 0 },
      rememberedRoutes: [{ exeName: 'music.exe', deviceIds: ['tv'] }],
      defaultDeviceId: 'speakers',
      deviceSelectionPrefilled: true,
    });

    backend.devices = [SPEAKERS];
    await state().refreshDevices(true);
    // The restore rides the assignment queue behind the refresh; let it land.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // With the route released, the programme plays through the default again —
    // which is exactly what the board now says.
    expect(state().selectedDeviceIds).toEqual(['speakers']);

    backend.devices = [SPEAKERS, TV];
    await state().refreshDevices(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state().routedPids[MUSIC.pid]).toEqual(['tv']);
    expect(state().selectedDeviceIds).toEqual(['tv']);
  });

  it('replaces the prefilled guess on the first device click instead of adding to it', () => {
    installBackend();
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC],
      defaultDeviceId: 'speakers',
    });
    state().selectProcess(1001);
    expect(state().selectedDeviceIds).toEqual(['speakers']);

    // Choosing a device while the target is still the app's own guess means
    // "play through that one instead" — never "play through both".
    state().toggleDeviceSelection('tv');
    expect(state().selectedDeviceIds).toEqual(['tv']);
    expect(state().deviceSelectionPrefilled).toBe(false);
    expect(lastLog()?.message).toContain('TV');

    // From then on it is the user's own list, so clicks add and remove.
    state().toggleDeviceSelection('speakers');
    expect(state().selectedDeviceIds).toEqual(['tv', 'speakers']);
    state().toggleDeviceSelection('tv');
    expect(state().selectedDeviceIds).toEqual(['speakers']);
  });

  it('appends a copy from the add menu, never taking the primary seat', () => {
    installBackend();
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC],
      defaultDeviceId: 'speakers',
    });
    state().selectProcess(1001);
    // The plan is still the app's own single-device guess. Reaching for "add"
    // has to leave that device as the primary and put the new one on the tail —
    // the flaw the add menu used to have was replacing the guess, which made
    // the device you asked to add the one Windows played.
    expect(state().selectedDeviceIds).toEqual(['speakers']);
    expect(state().deviceSelectionPrefilled).toBe(true);

    state().appendDeviceTarget('tv');

    expect(state().selectedDeviceIds).toEqual(['speakers', 'tv']);
    expect(state().deviceSelectionPrefilled).toBe(false);
  });

  it('promotes a staged device to primary, swapping roles rather than dropping it', () => {
    installBackend();
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC],
      selectedDeviceIds: ['speakers', 'tv'],
      deviceSelectionPrefilled: false,
    });

    state().setPrimaryDevice('tv');

    // The old primary becomes a copy: nothing the user staged leaves the plan.
    expect(state().selectedDeviceIds).toEqual(['tv', 'speakers']);
  });

  it('replaces the primary with a device from outside the plan, keeping the copies', () => {
    installBackend();
    reset({
      devices: [SPEAKERS, TV, HEADPHONES],
      sessions: [MUSIC],
      selectedDeviceIds: ['speakers', 'tv'],
      deviceSelectionPrefilled: false,
    });

    state().setPrimaryDevice('headphones');

    expect(state().selectedDeviceIds).toEqual(['headphones', 'tv']);
  });

  it("is a no-op when the picked device already holds the plan's first seat", () => {
    installBackend();
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC],
      // The plan's first entry is the seat, whatever the delay values say.
      selectedDeviceIds: ['tv', 'speakers'],
      deviceDelays: { tv: 100, speakers: 0 },
      deviceSelectionPrefilled: false,
    });

    state().setPrimaryDevice('tv');

    expect(state().selectedDeviceIds).toEqual(['tv', 'speakers']);
  });

  it('seats a device that carries a larger compensation than the rest', () => {
    installBackend();
    reset({
      devices: [SPEAKERS, TV, HEADPHONES],
      sessions: [MUSIC],
      selectedDeviceIds: ['speakers', 'tv'],
      deviceDelays: { headphones: 50, tv: 10 },
      deviceSelectionPrefilled: false,
    });

    // The delay values are the copies' compensation, not a vote on the seat:
    // a move the user asks for lands as asked, and recalibrating after it is
    // the wizard's job. From outside the plan it replaces the seat holder and
    // keeps the copies; from inside, roles swap and membership is kept.
    state().setPrimaryDevice('headphones');
    expect(state().selectedDeviceIds).toEqual(['headphones', 'tv']);

    // ...and the same freedom inside the plan.
    state().setPrimaryDevice('tv');
    expect(state().selectedDeviceIds).toEqual(['tv', 'headphones']);
  });

  it('adds a first device when nothing is staged', () => {
    installBackend();
    reset({ devices: [SPEAKERS, TV], sessions: [MUSIC], selectedDeviceIds: [] });

    state().setPrimaryDevice('tv');

    expect(state().selectedDeviceIds).toEqual(['tv']);
  });

  it('replaces the plan member actually holding the seat', () => {
    installBackend();
    reset({
      devices: [SPEAKERS, TV, HEADPHONES],
      sessions: [MUSIC],
      // The plan's first entry holds the seat — the TV here — so picking an
      // outside device replaces the TV, not some other entry, and the copies
      // the plan already had stay exactly as they were.
      selectedDeviceIds: ['tv', 'speakers'],
      deviceDelays: { tv: 100, speakers: 0, headphones: 50 },
      deviceSelectionPrefilled: false,
    });

    state().setPrimaryDevice('headphones');

    expect(state().selectedDeviceIds).toEqual(['headphones', 'speakers']);
  });

  it('keeps the shared targets when a process is added to the selection', () => {
    installBackend();
    reset({ devices: [SPEAKERS, TV], sessions: [MUSIC, GAME], selectedDeviceIds: ['tv'] });

    state().toggleProcessSelection(1001);
    expect(state().selectedPids).toEqual([1001]);
    expect(state().selectedDeviceIds).toEqual(['tv']);

    state().toggleProcessSelection(1002);
    expect(state().selectedPids).toEqual([1001, 1002]);

    state().toggleProcessSelection(1001);
    state().toggleProcessSelection(1002);
    expect(state().selectedPids).toEqual([]);
    expect(state().selectedDeviceIds).toEqual([]);
  });

  it('promotes a staged copy to the primary seat without touching membership', () => {
    installBackend();
    reset({ devices: [SPEAKERS, TV], sessions: [MUSIC], selectedDeviceIds: ['tv', 'speakers'] });

    state().promoteDevice('speakers');

    // A reorder of the plan and nothing else: the same devices, the copy now
    // first, and nothing routed or logged — no route moves until Apply.
    expect(state().selectedDeviceIds).toEqual(['speakers', 'tv']);
    expect(state().routedPids).toEqual({});
    expect(state().logs).toHaveLength(0);
  });

  it('leaves the plan alone when the promoted device is already the primary or absent', () => {
    installBackend();
    reset({ devices: [SPEAKERS, TV], sessions: [MUSIC], selectedDeviceIds: ['tv', 'speakers'] });

    state().promoteDevice('tv');
    expect(state().selectedDeviceIds).toEqual(['tv', 'speakers']);

    state().promoteDevice('headphones');
    expect(state().selectedDeviceIds).toEqual(['tv', 'speakers']);
  });

  it('freezes the plan it just promoted, so a refresh cannot undo the seat', async () => {
    // Promoting is the user's own staging, not the app's guess: the plan must
    // stop being derived, or the next device refresh would re-derive the seat
    // from the live route and quietly move it back under the user.
    const backend = installBackend({ devices: [SPEAKERS, TV] });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC],
      selectedPids: [MUSIC.pid],
      selectedDeviceIds: ['speakers', 'tv'],
      routedPids: { [MUSIC.pid]: ['speakers', 'tv'] },
      engineGenerations: { [MUSIC.pid]: 1 },
      deviceSelectionPrefilled: true,
      defaultDeviceId: 'speakers',
    });

    state().promoteDevice('tv');
    expect(state().selectedDeviceIds).toEqual(['tv', 'speakers']);
    expect(state().deviceSelectionPrefilled).toBe(false);

    backend.devices = [SPEAKERS, TV];
    await state().refreshDevices(true);

    // The live route still runs [speakers, tv], but the seat the user moved
    // stays where they put it.
    expect(state().selectedDeviceIds).toEqual(['tv', 'speakers']);
  });
});

describe('applyRoute', () => {
  it('routes in the plan order, remembers it, and offers the way back', async () => {
    const backend = installBackend();
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC],
      selectedPids: [1001],
      selectedDeviceIds: ['speakers', 'tv'],
      // A delay on the TV does not move the seat: the plan's first device is
      // the one the OS plays natively, whatever the copies are compensated by.
      deviceDelays: { tv: -30 },
      autoRemember: true,
    });

    await state().applyRoute();

    const apply = backend.calls.find((call) => call.cmd === 'apply_route');
    expect(apply?.args).toMatchObject({
      pid: 1001,
      exeName: 'music.exe',
      deviceIds: ['speakers', 'tv'],
      remember: true,
    });
    expect(state().routedPids[1001]).toEqual(['speakers', 'tv']);
    expect(state().engineGenerations[1001]).toBe(1);
    expect(state().rememberedRoutes).toEqual([
      { exeName: 'music.exe', deviceIds: ['speakers', 'tv'] },
    ]);
    expect(state().undoSnapshot).toMatchObject({
      remembered: true,
      deviceName: 'Speakers',
      deviceCount: 2,
      entries: [{ pid: 1001, exeName: 'music.exe', previous: null }],
    });
    expect(lastLog()?.level).toBe('success');
    expect(state().applying).toBe(false);
  });

  it('does not remember the route when auto-remember is off', async () => {
    const backend = installBackend();
    reset({
      devices: [SPEAKERS],
      sessions: [MUSIC],
      selectedPids: [1001],
      selectedDeviceIds: ['speakers'],
      autoRemember: false,
    });

    await state().applyRoute();

    expect(backend.calls.find((c) => c.cmd === 'apply_route')?.args.remember).toBe(false);
    expect(state().rememberedRoutes).toEqual([]);
  });

  it('keeps the previous route in the undo snapshot so the way back exists', async () => {
    installBackend();
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC],
      selectedPids: [1001],
      selectedDeviceIds: ['tv'],
      routedPids: { 1001: ['speakers'] },
    });

    await state().applyRoute();

    expect(state().routedPids[1001]).toEqual(['tv']);
    expect(state().undoSnapshot?.entries[0]?.previous).toEqual(['speakers']);
  });

  it('reports a rejected route and leaves the route state alone', async () => {
    const backend = installBackend({ fail: (cmd) => cmd === 'apply_route' });
    reset({
      devices: [SPEAKERS],
      sessions: [MUSIC],
      selectedPids: [1001],
      selectedDeviceIds: ['speakers'],
    });

    await state().applyRoute();

    expect(state().routedPids[1001]).toBeUndefined();
    expect(state().undoSnapshot).toBeNull();
    expect(lastLog()?.level).toBe('error');
    expect(backend.calls.some((c) => c.cmd === 'apply_route')).toBe(true);
  });

  it('keeps the processes that succeeded when only some were rejected', async () => {
    installBackend({
      sessions: [MUSIC, GAME],
      // The second process is the one the backend refuses.
      fail: (cmd, args) => cmd === 'apply_route' && args.pid === 1002,
    });
    reset({
      devices: [SPEAKERS],
      sessions: [MUSIC, GAME],
      selectedPids: [1001, 1002],
      selectedDeviceIds: ['speakers'],
    });

    await state().applyRoute();

    expect(state().routedPids[1001]).toEqual(['speakers']);
    expect(state().routedPids[1002]).toBeUndefined();
    expect(state().undoSnapshot?.entries).toHaveLength(1);
    expect(lastLog()?.level).toBe('error');
  });

  it('refuses to route without a process and a device', async () => {
    installBackend();
    reset({ devices: [SPEAKERS], sessions: [MUSIC], selectedPids: [], selectedDeviceIds: [] });

    await state().applyRoute();

    expect(lastLog()?.level).toBe('error');
    expect(state().routedPids).toEqual({});
  });

  it('lands on the sibling that already holds the program’s route', async () => {
    // The assignment and the engine are the executable's, kept under whichever
    // pid landed them. Routing a sibling instead would leave the old engine
    // running beside the new one — two captures of one tree — and the undo
    // offer would name a pid whose stop finds nothing to stop.
    const SIBLING: AudioSession = { pid: 1005, exe_name: 'music.exe' };
    const backend = installBackend({ sessions: [MUSIC, SIBLING] });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC, SIBLING],
      selectedPids: [MUSIC.pid],
      selectedDeviceIds: ['speakers', 'tv'],
      routedPids: { [SIBLING.pid]: ['tv'] },
    });

    await state().applyRoute();

    const apply = backend.calls.find((call) => call.cmd === 'apply_route');
    expect(apply?.args).toMatchObject({ pid: SIBLING.pid, exeName: 'music.exe' });
    expect(state().routedPids[MUSIC.pid]).toBeUndefined();
    expect(state().routedPids[SIBLING.pid]).toEqual(['speakers', 'tv']);
    expect(state().undoSnapshot?.entries[0]).toMatchObject({
      pid: SIBLING.pid,
      previous: ['tv'],
    });
  });

  it('names a device that left between staging and apply as one that has left', async () => {
    // The undo card speaks to the user, and an endpoint GUID answers nothing.
    // A device unplugged while the plan sat staged is exactly the case the
    // components stopped printing — the store's own strings have to follow the
    // same rule, in the offer and in the log alike.
    installBackend();
    reset({
      devices: [SPEAKERS],
      sessions: [MUSIC],
      selectedPids: [MUSIC.pid],
      // 'tv' was staged while it was live and has left since; the apply still
      // lands, and what the offer says about it must not be the raw id.
      selectedDeviceIds: ['tv'],
    });

    await state().applyRoute();

    expect(state().undoSnapshot?.deviceName).toBe(i18next.t('stage.deviceGone'));
    expect(state().undoSnapshot?.deviceName).not.toContain('tv');
    const routed = state()
      .logs.filter((entry) => entry.level === 'success')
      .at(-1);
    expect(routed?.message).not.toContain('tv');
  });

  it('asks the engines again once the route resolves', async () => {
    // The engine agent's requirement: a stop that lands later than this
    // resolve can tear the engine down behind the badges, so the pass has to
    // run on the resolve — after `apply_route` answers, not beside it — and the
    // readings come back with the route instead of waiting for Core Audio.
    const backend = installBackend();
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC],
      selectedPids: [MUSIC.pid],
      selectedDeviceIds: ['speakers', 'tv'],
    });

    await state().applyRoute();

    const seen = backend.calls.map((call) => call.cmd);
    expect(seen.lastIndexOf('apply_route')).toBeLessThan(
      seen.lastIndexOf('get_active_duplications'),
    );
    expect(state().deviceLatencyMs.tv).toBe(20);
  });
});

describe('stopRoute', () => {
  it('drops the route and drops the undo offer that described it', async () => {
    installBackend();
    reset({
      devices: [SPEAKERS],
      sessions: [MUSIC],
      routedPids: { 1001: ['speakers'] },
      undoSnapshot: {
        entries: [{ pid: 1001, exeName: 'music.exe', previous: null }],
        remembered: true,
        deviceName: 'Speakers',
        deviceCount: 1,
      },
    });

    await state().stopRoute(1001);

    expect(state().routedPids[1001]).toBeUndefined();
    expect(state().undoSnapshot).toBeNull();
    // Going back to the system default is the normal outcome, not a win: it
    // reports, it does not congratulate.
    expect(lastLog()?.level).toBe('info');
  });

  it('puts the route back when the backend refuses the stop', async () => {
    installBackend({ routes: { 1001: ['speakers'] }, fail: (cmd) => cmd === 'stop_route' });
    reset({ devices: [SPEAKERS], sessions: [MUSIC], routedPids: { 1001: ['speakers'] } });

    await state().stopRoute(1001);

    // Showing it as stopped while it is still playing would be a lie the user
    // cannot act on.
    expect(state().routedPids[1001]).toEqual(['speakers']);
    expect(lastLog()?.level).toBe('error');
  });

  it('does nothing for a process that was never routed', async () => {
    const backend = installBackend();
    reset({ devices: [SPEAKERS], sessions: [MUSIC] });

    await state().stopRoute(1001);

    expect(backend.calls.some((c) => c.cmd === 'stop_route')).toBe(false);
  });

  it('takes the whole program off the selection when a sibling holds the route', async () => {
    // The ✕ the rail passes is the route's holder, but the board can be looking
    // at any process of that program. Filtering the selection by the holder's
    // pid alone left the sibling selected with the stopped plan still drawn
    // under it — a route the board no longer offers any way to stop, since the
    // row it belonged to has just gone unrouted.
    const SIBLING: AudioSession = { pid: 1006, exe_name: 'music.exe' };
    const backend = installBackend();
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC, SIBLING, GAME],
      selectedPids: [SIBLING.pid],
      selectedDeviceIds: ['speakers', 'tv'],
      routedPids: { [MUSIC.pid]: ['speakers', 'tv'] },
    });

    await state().stopRoute(MUSIC.pid);

    expect(state().selectedPids).toEqual([]);
    expect(state().selectedDeviceIds).toEqual([]);
    expect(state().routedPids).toEqual({});
    expect(backend.calls.filter((c) => c.cmd === 'stop_route')).toHaveLength(1);
  });

  it('leaves the rest of the selection alone when a program stops', async () => {
    // A batch stays a batch: stopping one program takes that program's
    // processes out — the sibling above included — and nothing else's.
    const SIBLING: AudioSession = { pid: 1007, exe_name: 'music.exe' };
    installBackend();
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC, SIBLING, GAME],
      selectedPids: [SIBLING.pid, GAME.pid],
      selectedDeviceIds: ['speakers', 'tv'],
      routedPids: { [MUSIC.pid]: ['speakers', 'tv'], [GAME.pid]: ['tv'] },
    });

    await state().stopRoute(MUSIC.pid);

    expect(state().selectedPids).toEqual([GAME.pid]);
    expect(state().selectedDeviceIds).toEqual(['speakers', 'tv']);
    expect(state().routedPids).toEqual({ [GAME.pid]: ['tv'] });
  });

  it('names the device when the audio service refused the release', async () => {
    // Which of its two failures a stop was is the backend's to say. Reading the
    // route list for the answer — the old guess — turned a *refused* release
    // into the sibling line whenever a dead sibling's entry was still standing
    // under the same exe: the device stayed booked and the user was never told.
    const DEAD_SIBLING: AudioSession = { pid: 1011, exe_name: 'music.exe' };
    installBackend({
      stopOutcomes: {
        [MUSIC.pid]: { released: false, pinned_device: 'tv', sibling_held: false },
      },
    });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC, DEAD_SIBLING],
      // The sibling's route is the stale entry: this program's own stop is not
      // held by anything that is still playing.
      routedPids: { [MUSIC.pid]: ['tv'], [DEAD_SIBLING.pid]: ['tv'] },
    });

    await state().stopRoute(MUSIC.pid);

    expect(lastLog()?.level).toBe('error');
    expect(lastLog()?.message).toContain('TV');
  });

  it('says the way out is the sibling route when the backend says so', async () => {
    // The other half of the same field: a held assignment is not a stuck
    // endpoint, and pointing at the settings reset here would send the user to
    // a button that cannot help them.
    const SIBLING: AudioSession = { pid: 1012, exe_name: 'music.exe' };
    installBackend({
      stopOutcomes: {
        [MUSIC.pid]: { released: false, pinned_device: 'tv', sibling_held: true },
      },
    });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC, SIBLING],
      routedPids: { [MUSIC.pid]: ['tv'], [SIBLING.pid]: ['speakers', 'tv'] },
    });

    await state().stopRoute(MUSIC.pid);

    expect(lastLog()?.level).toBe('info');
    expect(lastLog()?.message).toContain('another process');
  });

  it('says the device could not be read when there is no name to give', async () => {
    installBackend({
      stopOutcomes: {
        [MUSIC.pid]: { released: false, pinned_device: null, sibling_held: false },
      },
    });
    reset({ devices: [SPEAKERS], sessions: [MUSIC], routedPids: { [MUSIC.pid]: ['speakers'] } });

    await state().stopRoute(MUSIC.pid);

    expect(lastLog()?.level).toBe('error');
    expect(lastLog()?.message).toContain('music.exe');
  });

  it('does not let a reconciliation asked before the stop put the route back', async () => {
    // `get_active_duplications` is asked in one breath and committed in another,
    // and its reply pictures the engines as they were at the ask. A stop landing
    // inside that window would be written over: the badge and the generation of
    // an engine that no longer exists, which then swallows every event the next
    // engine sends as stale.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const PLAYER: AudioSession = { pid: 8301, exe_name: 'reconciled.exe' };
    installBackend({
      sessions: [PLAYER],
      routes: { [PLAYER.pid]: ['speakers', 'tv'] },
      routeGenerations: { [PLAYER.pid]: 3 },
      holdActive: gate,
    });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [PLAYER],
      routedPids: { [PLAYER.pid]: ['speakers', 'tv'] },
      engineGenerations: { [PLAYER.pid]: 3 },
    });

    const reconciling = state().reconcileActiveDuplications();
    await state().stopRoute(PLAYER.pid);
    release();
    await reconciling;

    expect(state().routedPids[PLAYER.pid]).toBeUndefined();
    expect(state().engineGenerations[PLAYER.pid]).toBeUndefined();
  });

  it('does not let a reconciliation asked while the stop is still in flight put it back', async () => {
    // One invalidation only retires the asks made *before* the stop. The engine
    // comes down when `stop_route` answers, and the teardown itself raises a Core
    // Audio change: a reconciliation asked inside that window still pictures the
    // live engine and lands after the stop, putting the badge and the generation
    // of an engine that has just gone back on screen. Nothing asks a third time on
    // a quiet machine, so the stopped route would be drawn as playing forever.
    let releaseStop: () => void = () => {};
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const PLAYER: AudioSession = { pid: 8331, exe_name: 'mid-stop.exe' };
    installBackend({
      sessions: [PLAYER],
      routes: { [PLAYER.pid]: ['speakers', 'tv'] },
      routeGenerations: { [PLAYER.pid]: 4 },
      holdStop: stopGate,
    });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [PLAYER],
      routedPids: { [PLAYER.pid]: ['speakers', 'tv'] },
      engineGenerations: { [PLAYER.pid]: 4 },
    });

    const stopping = state().stopRoute(PLAYER.pid);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state().routedPids[PLAYER.pid]).toBeUndefined();

    const reconciling = state().reconcileActiveDuplications();
    releaseStop();
    await stopping;
    await reconciling;

    // Either the answer was retired before it could land, or it landed and its
    // route is taken back again — the two paths the stop has to survive. A latency
    // reading is not asserted either way: it is only ever drawn for a device that
    // is a mirror right now, and the next pass rebuilds the table whole.
    expect(state().routedPids[PLAYER.pid]).toBeUndefined();
    expect(state().engineGenerations[PLAYER.pid]).toBeUndefined();
  });

  it('does not let an answer that arrives after the stop revive the route', async () => {
    // The other half of the second retirement: an ask made inside the stop's window
    // whose answer comes in *after* the stop has landed. The take-back has already
    // run by then and has nothing to take back, so this reply is stopped by being
    // retired, not by being undone — and it is the ask that a stop's own teardown
    // provokes, which is the commonest one there is.
    let releaseAsk: () => void = () => {};
    const askGate = new Promise<void>((resolve) => {
      releaseAsk = resolve;
    });
    let releaseStop: () => void = () => {};
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const PLAYER: AudioSession = { pid: 8333, exe_name: 'late-answer.exe' };
    installBackend({
      sessions: [PLAYER],
      routes: { [PLAYER.pid]: ['speakers', 'tv'] },
      routeGenerations: { [PLAYER.pid]: 4 },
      holdActive: askGate,
      holdStop: stopGate,
    });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [PLAYER],
      routedPids: { [PLAYER.pid]: ['speakers', 'tv'] },
      engineGenerations: { [PLAYER.pid]: 4 },
    });

    const stopping = state().stopRoute(PLAYER.pid);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const lateAnswer = state().reconcileActiveDuplications();
    releaseStop();
    await stopping;
    releaseAsk();
    await lateAnswer;

    expect(state().routedPids[PLAYER.pid]).toBeUndefined();
    expect(state().engineGenerations[PLAYER.pid]).toBeUndefined();
  });

  it('takes back a route an answer revived while the stop was still in the air', async () => {
    // The asks are one thing, the replies already committed another: an answer that
    // lands *during* the stop has written the badge back and no later retirement can
    // unwrite it. What it drew can only be the engine this stop is taking down, and
    // the generation it wore says so — so the badge goes back down with the route
    // rather than waiting for a next event that a quiet machine never sends.
    let releaseStop: () => void = () => {};
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const PLAYER: AudioSession = { pid: 8332, exe_name: 'revived-mid-stop.exe' };
    installBackend({
      sessions: [PLAYER],
      routes: { [PLAYER.pid]: ['speakers', 'tv'] },
      routeGenerations: { [PLAYER.pid]: 4 },
      holdStop: stopGate,
    });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [PLAYER],
      routedPids: { [PLAYER.pid]: ['speakers', 'tv'] },
      engineGenerations: { [PLAYER.pid]: 4 },
    });

    const stopping = state().stopRoute(PLAYER.pid);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A notification arrives and the answer comes straight back: the engine is still
    // running on the backend, so the route reappears with the generation the stop
    // is retiring.
    await state().reconcileActiveDuplications();
    expect(state().routedPids[PLAYER.pid]).toEqual(['speakers', 'tv']);

    releaseStop();
    await stopping;

    expect(state().routedPids[PLAYER.pid]).toBeUndefined();
    expect(state().engineGenerations[PLAYER.pid]).toBeUndefined();
  });

  it('restores the program again when it launches afresh after a stop', async () => {
    // The sibling claim a stop makes is per pid on purpose: the decided set is
    // never pruned against the live list, so a recycled pid that now belongs to
    // another program loses auto-restore for this run — and a program that quit
    // and started again is a new subject, which is the whole point of the memory.
    const STOPPED: AudioSession = { pid: 8341, exe_name: 'relaunched.exe' };
    const HELPER: AudioSession = { pid: 8342, exe_name: 'relaunched.exe' };
    const FRESH: AudioSession = { pid: 8343, exe_name: 'relaunched.exe' };
    installBackend({ sessions: [STOPPED, HELPER] });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [STOPPED, HELPER],
      routedPids: { [STOPPED.pid]: ['tv'] },
      rememberedRoutes: [{ exeName: 'relaunched.exe', deviceIds: ['tv'] }],
      autoRemember: true,
    });

    await state().stopRoute(STOPPED.pid);
    expect(state().routedPids).toEqual({});

    // The program comes back with processes the stop never named.
    installBackend({ sessions: [FRESH] });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [FRESH],
      rememberedRoutes: [{ exeName: 'relaunched.exe', deviceIds: ['tv'] }],
      autoRemember: true,
    });
    await state().restoreRememberedRoutes();

    expect(state().routedPids[FRESH.pid]).toEqual(['tv']);
  });
});

describe('reset of left-behind assignments', () => {
  it('names the device each program stays fixed to', async () => {
    // The two arrays are parallel by contract: the names come in one list and
    // the endpoints in the other, and a log that mixed them up would blame the
    // wrong device for the wrong program.
    installBackend({
      resetOutcome: {
        released: 1,
        still_pinned: ['music.exe', 'game.exe'],
        still_pinned_devices: ['tv', null],
      },
    });
    reset({ devices: [SPEAKERS, TV], sessions: [MUSIC, GAME] });

    await state().resetPinnedEndpoints();

    const message = state()
      .logs.filter((entry) => entry.level === 'error')
      .map((entry) => entry.message)
      .join(' / ');
    expect(message).toContain('music.exe (still fixed to TV)');
    // The second program has no device to name — the service would not answer
    // for it — and that has to be said rather than quietly left out.
    expect(message).toContain('game.exe (the audio service would not say which device)');
  });
});

describe('engine events', () => {
  it('clears the route when the engine reports an error for the live generation', async () => {
    const backend = installBackend();
    reset({
      devices: [SPEAKERS],
      sessions: [MUSIC],
      routedPids: { 1001: ['speakers'] },
      engineGenerations: { 1001: 3 },
    });

    state().handleDuplicationStopped({
      pid: 1001,
      generation: 3,
      reason: 'error',
      error: 'device lost',
    });

    expect(state().routedPids[1001]).toBeUndefined();
    expect(state().engineGenerations[1001]).toBeUndefined();
    expect(lastLog()?.level).toBe('error');
    // And it ends through the stop, not just locally: the engine took its
    // mirrors down with itself but not the endpoint Windows was told to play
    // this program on, and an assignment left behind with no route on the board
    // is one the user has no way to release.
    await new Promise((r) => setTimeout(r, 0));
    expect(backend.calls.some((c) => c.cmd === 'stop_route')).toBe(true);
  });

  it('ignores a stop that belongs to a route that has already been replaced', () => {
    installBackend();
    reset({
      devices: [SPEAKERS],
      sessions: [MUSIC],
      routedPids: { 1001: ['speakers'] },
      engineGenerations: { 1001: 4 },
    });

    state().handleDuplicationStopped({
      pid: 1001,
      generation: 2,
      reason: 'error',
      error: 'stale',
    });

    expect(state().routedPids[1001]).toEqual(['speakers']);
  });

  it('ignores the ack of a stop the store already applied', () => {
    installBackend();
    reset({
      devices: [SPEAKERS],
      sessions: [MUSIC],
      routedPids: {},
      engineGenerations: { 1001: 1 },
    });

    state().handleDuplicationStopped({ pid: 1001, generation: 1, reason: 'stopped', error: null });

    expect(state().routedPids[1001]).toBeUndefined();
    expect(lastLog()).toBeUndefined();
  });

  it('drops only the mirror that failed', () => {
    installBackend();
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC],
      // The first id is the primary the OS plays itself; 'tv' is the copy.
      routedPids: { 1001: ['speakers', 'tv'] },
      engineGenerations: { 1001: 1 },
    });

    state().handleMirrorFailed({ pid: 1001, generation: 1, deviceId: 'tv', error: 'busy' });

    expect(state().routedPids[1001]).toEqual(['speakers']);
    expect(lastLog()?.level).toBe('error');
  });

  it('ends the route when the device that failed is the one the OS plays', async () => {
    // The backend reports a mirror and never the primary, so this is the store
    // and the engine disagreeing about the route. Dropping the primary would
    // promote the copy into its place: drawn as the device Windows plays,
    // driven as a duplicate of a stream that is no longer being produced.
    const backend = installBackend();
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC],
      routedPids: { 1001: ['speakers', 'tv'] },
      engineGenerations: { 1001: 1 },
    });

    state().handleMirrorFailed({ pid: 1001, generation: 1, deviceId: 'speakers', error: 'busy' });

    expect(state().routedPids[1001]).toBeUndefined();
    expect(state().engineGenerations[1001]).toBeUndefined();
    expect(lastLog()?.level).toBe('error');
    // Ended the way a stop ends: the program's fixed endpoint goes back with it.
    await new Promise((r) => setTimeout(r, 0));
    expect(backend.calls.some((c) => c.cmd === 'stop_route')).toBe(true);
  });

  it('ignores a mirror failure from a superseded engine', () => {
    installBackend();
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC],
      routedPids: { 1001: ['tv', 'speakers'] },
      engineGenerations: { 1001: 2 },
    });

    state().handleMirrorFailed({ pid: 1001, generation: 1, deviceId: 'tv', error: 'busy' });

    expect(state().routedPids[1001]).toEqual(['tv', 'speakers']);
  });

  it('reports a dead feed tap on the feed’s channel, not as a route that never existed', () => {
    // A programme that only feeds runs an engine with no device of the board and
    // therefore no generation here, so the route guard would swallow its death.
    // What it is, is the wire into the carrier going quiet: the rows have to say
    // so, and nothing may be retired as a route.
    const SOURCE: AudioSession = { pid: 9001, exe_name: 'sender.exe' };
    installBackend();
    reset({
      devices: [SPEAKERS],
      sessions: [SOURCE],
      feeds: { [SOURCE.pid]: [9002] },
      feedCarrier: { render: 'cable-in', capture: 'cable-out' },
    });

    state().handleDuplicationStopped({
      pid: SOURCE.pid,
      generation: 7,
      reason: 'error',
      error: 'the carrier left',
    });

    expect(state().feedTapFailures['sender.exe']).toBe('the carrier left');
    expect(state().routedPids[SOURCE.pid]).toBeUndefined();
    expect(state().errorNotice?.message).toContain('sender.exe');
    expect(lastLog()?.level).toBe('error');
  });

  it('does not let a reconciliation asked before the engine died put the route back', async () => {
    // Same shape as a stop, and the reason it cannot be left to "the next pass":
    // the process exited, so the session refresh that would prune the badge has
    // already run by the time the held reply lands. The answer still lists the
    // engine and re-creates both the badge and its generation — a route drawn as
    // playing for a program that has left, with nothing left to correct it.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const PLAYER: AudioSession = { pid: 8401, exe_name: 'exited-engine.exe' };
    installBackend({
      sessions: [PLAYER],
      routes: { [PLAYER.pid]: ['speakers', 'tv'] },
      routeGenerations: { [PLAYER.pid]: 6 },
      holdActive: gate,
    });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [PLAYER],
      routedPids: { [PLAYER.pid]: ['speakers', 'tv'] },
      engineGenerations: { [PLAYER.pid]: 6 },
    });

    const reconciling = state().reconcileActiveDuplications();
    state().handleDuplicationStopped({
      pid: PLAYER.pid,
      generation: 6,
      reason: 'process-exited',
      error: null,
    });
    expect(state().routedPids[PLAYER.pid]).toBeUndefined();
    release();
    await reconciling;

    expect(state().routedPids[PLAYER.pid]).toBeUndefined();
    expect(state().engineGenerations[PLAYER.pid]).toBeUndefined();
  });

  it('does not let a reconciliation asked before a mirror died put that device back', async () => {
    // One engine finishing its devices asks for the readings, and a mirror can go
    // quiet inside that window. The reply still names the dead device: the badge
    // regains it, and a latency reading appears for a stream the engine stopped
    // writing — the exact lie `duplication-mirror-failed` exists to report.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const PLAYER: AudioSession = { pid: 8411, exe_name: 'lost-mirror.exe' };
    installBackend({
      sessions: [PLAYER],
      routes: { [PLAYER.pid]: ['speakers', 'tv'] },
      routeGenerations: { [PLAYER.pid]: 1 },
      holdActive: gate,
    });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [PLAYER],
      routedPids: { [PLAYER.pid]: ['speakers', 'tv'] },
      engineGenerations: { [PLAYER.pid]: 1 },
    });

    const reconciling = state().reconcileActiveDuplications();
    state().handleMirrorFailed({ pid: PLAYER.pid, generation: 1, deviceId: 'tv', error: 'busy' });
    expect(state().routedPids[PLAYER.pid]).toEqual(['speakers']);
    release();
    await reconciling;

    expect(state().routedPids[PLAYER.pid]).toEqual(['speakers']);
    expect(state().deviceLatencyMs.tv).toBeUndefined();
  });

  it('names a mirror that is no longer on the list as one that has left', () => {
    // The notice this event exists to raise must not print an endpoint GUID:
    // the device may be gone from `devices` faster than the badge is pruned,
    // and an id in a sentence is the same lie on the store's side that the
    // components were called out for.
    installBackend();
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC],
      routedPids: { 1001: ['speakers', 'vanished-endpoint'] },
      engineGenerations: { 1001: 1 },
    });

    state().handleMirrorFailed({
      pid: 1001,
      generation: 1,
      deviceId: 'vanished-endpoint',
      error: 'busy',
    });

    expect(state().errorNotice?.message).toContain(i18next.t('stage.deviceGone'));
    expect(state().errorNotice?.message).not.toContain('vanished-endpoint');
  });

  it('takes the dead program out of the selection as a whole program', () => {
    // The engine died with one process; the route was the program's, and the
    // selection is drawn per process. A sibling left standing keeps a plan for
    // a route nothing runs — the same stale board a manual stop clears for
    // every process of the executable, so this local clear has to follow the
    // exe rule too, and take only the dead program's processes with it.
    const HOLDER: AudioSession = { pid: 4201, exe_name: 'dying.exe' };
    const SIBLING: AudioSession = { pid: 4202, exe_name: 'dying.exe' };
    installBackend();
    reset({
      devices: [SPEAKERS, TV],
      sessions: [HOLDER, SIBLING, GAME],
      routedPids: { [HOLDER.pid]: ['speakers', 'tv'] },
      engineGenerations: { [HOLDER.pid]: 1 },
      selectedPids: [SIBLING.pid, GAME.pid],
      selectedDeviceIds: ['speakers', 'tv'],
    });

    state().handleDuplicationStopped({
      pid: HOLDER.pid,
      generation: 1,
      reason: 'process-exited',
      error: null,
    });

    expect(state().routedPids).toEqual({});
    expect(state().selectedPids).toEqual([GAME.pid]);
    expect(state().selectedDeviceIds).toEqual(['speakers', 'tv']);
  });

  it('takes the plan down with the selection when the dead program held all of it', () => {
    // A sibling alone in the selection is still in it with the route: once the
    // program's engine ends there is nothing left staged, and a non-empty
    // device plan under an empty selection is a frozen stale board.
    const HOLDER: AudioSession = { pid: 4211, exe_name: 'solo-dying.exe' };
    const SIBLING: AudioSession = { pid: 4212, exe_name: 'solo-dying.exe' };
    installBackend();
    reset({
      devices: [SPEAKERS, TV],
      sessions: [HOLDER, SIBLING],
      routedPids: { [HOLDER.pid]: ['speakers', 'tv'] },
      engineGenerations: { [HOLDER.pid]: 1 },
      selectedPids: [SIBLING.pid],
      selectedDeviceIds: ['speakers', 'tv'],
    });

    state().handleDuplicationStopped({
      pid: HOLDER.pid,
      generation: 1,
      reason: 'process-exited',
      error: null,
    });

    expect(state().selectedPids).toEqual([]);
    expect(state().selectedDeviceIds).toEqual([]);
  });
});

describe('session activity', () => {
  it('folds who is sounding into the programs the lists read', async () => {
    // Every row that draws one line per program asks by executable name — the
    // fold is what keeps that one lookup instead of a walk of the session list
    // on each store write. Both places that record sound have to fold it, or
    // the lists read a program as quiet while its process is playing.
    const SIBLING: AudioSession = { pid: 1003, exe_name: 'music.exe', playing: true };
    installBackend({ sessions: [MUSIC, SIBLING] });
    reset({ devices: [SPEAKERS], sessions: [] });

    await state().refreshSessions();
    expect(state().soundingExes['music.exe']).toBe(true);

    // The event path folds from the same list: a flip off for the only sounding
    // process of a program takes the program's own answer with it.
    state().handleSessionActivity({ pid: SIBLING.pid, active: false });
    expect(state().soundingExes['music.exe']).toBeUndefined();
    state().handleSessionActivity({ pid: MUSIC.pid, active: true });
    expect(state().soundingExes['music.exe']).toBe(true);
  });

  it('tracks the transitions the backend forwards', () => {
    installBackend();
    reset({ sessions: [MUSIC], soundingPids: {} });

    state().handleSessionActivity({ pid: 1001, active: true });
    expect(state().soundingPids[1001]).toBe(true);

    state().handleSessionActivity({ pid: 1001, active: false });
    expect(state().soundingPids[1001]).toBeUndefined();
  });

  it('records a transition for nobody the list can name', () => {
    // A transition that outruns the re-enumeration bringing its process has no
    // executable to be folded under. Recording it anyway is the half-state
    // where one table says a thing is playing and every per-program reader —
    // the rail, the board, the capsule, the status page, the title bar — says
    // it is not, which reads as the route having failed.
    installBackend({ sessions: [MUSIC] });
    reset({ sessions: [MUSIC] });

    state().handleSessionActivity({ pid: 2002, active: true });
    expect(state().soundingPids[2002]).toBeUndefined();
    expect(state().soundingExes).toEqual({});

    // The list does know this one, so both tables answer in the same pass.
    state().handleSessionActivity({ pid: MUSIC.pid, active: true });
    expect(state().soundingPids[MUSIC.pid]).toBe(true);
    expect(state().soundingExes['music.exe']).toBe(true);

    state().handleSessionActivity({ pid: MUSIC.pid, active: false });
    expect(state().soundingPids[MUSIC.pid]).toBeUndefined();
    expect(state().soundingExes['music.exe']).toBeUndefined();
  });

  it('names a process and its program in the pass that brings the list', async () => {
    const RENDERER: AudioSession = { pid: 2002, exe_name: 'chrome.exe', playing: true };
    installBackend({ sessions: [MUSIC, RENDERER] });
    reset({ sessions: [MUSIC] });

    state().handleSessionActivity({ pid: RENDERER.pid, active: true });
    expect(state().soundingExes['chrome.exe']).toBeUndefined();

    await state().refreshSessions();
    expect(state().soundingPids[RENDERER.pid]).toBe(true);
    expect(state().soundingExes['chrome.exe']).toBe(true);
  });

  it('reseeds from the session list, so a process that left it stops sounding', async () => {
    installBackend({
      sessions: [
        { pid: 1001, exe_name: 'music.exe', playing: true },
        { pid: 1002, exe_name: 'game.exe' },
      ],
    });
    reset({ soundingPids: { 1001: true, 1002: true } });

    await state().refreshSessions(true);

    expect(state().soundingPids).toEqual({ 1001: true });
  });
});

describe('the first session enumeration', () => {
  it('is what makes an empty list a statement about the machine', async () => {
    installBackend({ sessions: [] });
    reset();

    // Until the answer comes back, the rail owes the user a placeholder: an
    // empty list here is a round-trip still in flight, not an app that is quiet.
    expect(state().sessionsLoaded).toBe(false);

    await state().refreshSessions();

    expect(state().sessionsLoaded).toBe(true);
  });

  it('counts as returned when the enumeration refused', async () => {
    // A list that would not answer is not a list still on its way: "reading"
    // would stand there forever with nothing left to change it, and the failure
    // belongs in the record. The first enumeration is the app's own ask, though —
    // nobody pressed anything — so it reaches the log alone, not the Toast.
    installBackend({ fail: (cmd) => cmd === 'list_sessions' });
    reset();

    await state().refreshSessions();

    expect(state().sessionsLoaded).toBe(true);
    expect(lastLog()?.level).toBe('error');
    expect(state().errorNotice).toBeNull();
    // And the reason is kept where the list is drawn: an empty list is a claim
    // about the machine, a refused read is a claim about this moment, and the
    // rail has to be able to tell the two apart.
    expect(state().sessionsError).toContain('list_sessions');
  });

  it('clears the read failure on the enumeration that answers', async () => {
    installBackend({ fail: (cmd) => cmd === 'list_sessions' });
    reset();
    await state().refreshSessions();
    expect(state().sessionsError).not.toBeNull();

    installBackend({ sessions: [MUSIC] });
    await state().refreshSessions();

    expect(state().sessionsError).toBeNull();
    expect(state().sessions).toEqual([MUSIC]);
  });

  it('keeps a session refresh the notification provoked in the log', async () => {
    installBackend({ fail: (cmd) => cmd === 'list_sessions' });
    reset({ sessions: [MUSIC], sessionsLoaded: true });

    await state().refreshSessions(true);

    expect(lastLog()?.level).toBe('error');
    expect(state().sessions).toEqual([MUSIC]);
    expect(state().errorNotice).toBeNull();
  });

  it('raises the refresh the list row asked for', async () => {
    // Once the list exists, a refused re-read is a thing the user asked for that
    // did not happen, and it has to be said where they are looking.
    const backend = installBackend();
    reset({ sessions: [MUSIC] });
    await state().refreshSessions();
    expect(state().errorNotice).toBeNull();

    backend.fail = (cmd) => cmd === 'list_sessions';
    await state().refreshSessions();

    expect(lastLog()?.level).toBe('error');
    expect(state().errorNotice?.message).toContain('list_sessions');
  });

  it('takes a program whose route holder died out of the selection', async () => {
    // The session list is the authority that a single-device route's holder is
    // gone, and it drops the badge here — but the route was the *program's*,
    // and a surviving sibling left in the selection keeps planning a route the
    // audio service no longer runs. The same death through the engine event
    // clears the whole program; the list-driven path has to follow the exe rule
    // too, and leave every other program's selection alone.
    const HOLDER: AudioSession = { pid: 4221, exe_name: 'dead-holder.exe' };
    const SIBLING: AudioSession = { pid: 4222, exe_name: 'dead-holder.exe' };
    installBackend({ sessions: [SIBLING, GAME] });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [HOLDER, SIBLING, GAME],
      routedPids: { [HOLDER.pid]: ['tv'] },
      selectedPids: [SIBLING.pid, GAME.pid],
      selectedDeviceIds: ['tv'],
    });

    await state().refreshSessions();

    expect(state().routedPids).toEqual({});
    expect(state().selectedPids).toEqual([GAME.pid]);
    expect(state().selectedDeviceIds).toEqual(['tv']);
  });
});

describe('hotplug', () => {
  it('drops an unplugged device from the selection and from live routes', async () => {
    installBackend({ devices: [SPEAKERS] });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC],
      selectedPids: [1001],
      selectedDeviceIds: ['tv'],
      routedPids: { 1001: ['tv', 'speakers'] },
      defaultDeviceId: 'speakers',
    });

    await state().refreshDevices(true);

    expect(state().devices).toEqual([SPEAKERS]);
    expect(state().selectedDeviceIds).toEqual([]);
    expect(state().routedPids[1001]).toEqual(['speakers']);
  });

  it('releases a single-device route whose every device was unplugged', async () => {
    // A single-device route has no engine, so nothing else stops it: left
    // alone, its per-app assignment outlives the badge — skipped by the reset
    // (still booked as a live route) and by the stale sweep (the program is
    // still alive) — and the program keeps ignoring the user's device switches
    // with no route on the board to stop.
    //
    // Landed through the real seam: the release guard reads the generation
    // `applyRoute` recorded, and the backend reports 0 for a route that starts
    // no engine. Writing `engineGenerations: { 1001: 0 }` by hand here would
    // pass even if the two sides disagreed about what a single-device route
    // reports, which is the one thing this guard depends on.
    const backend = installBackend({ devices: [SPEAKERS, TV] });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC],
      selectedPids: [MUSIC.pid],
      selectedDeviceIds: [SPEAKERS.id],
      defaultDeviceId: TV.id,
    });

    await state().applyRoute();
    expect(state().routedPids[MUSIC.pid]).toEqual([SPEAKERS.id]);
    expect(state().engineGenerations[MUSIC.pid]).toBe(0);

    backend.devices = [TV];
    await state().refreshDevices(true);
    // The restore rides the assignment queue behind the refresh; let it land.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state().routedPids[MUSIC.pid]).toBeUndefined();
    const stopped = backend.calls.filter((c) => c.cmd === 'stop_route');
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.args.pid).toBe(MUSIC.pid);
  });

  it('releases the route the program holds while the board looks at a sibling', async () => {
    // The badge, the plan and the release are three different things: the
    // selection is drawn per process, while the assignment is the program's and
    // is booked under its lowest pid. A refresh that read the selection to
    // decide what to release would `stop_route` a process holding nothing — the
    // one bug shape this list keeps tripping over.
    const OWNER: AudioSession = { pid: 6601, exe_name: 'browser.exe' };
    const SHOWN: AudioSession = { pid: 6602, exe_name: 'browser.exe' };
    const backend = installBackend({ devices: [SPEAKERS] });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [OWNER, SHOWN],
      selectedPids: [SHOWN.pid],
      selectedDeviceIds: [SPEAKERS.id],
      // The one entry a route of this program has: the owner's, and engineless,
      // so the release below is the only path that can take it.
      routedPids: { [OWNER.pid]: ['tv'] },
      defaultDeviceId: SPEAKERS.id,
    });

    await state().refreshDevices(true);
    // The restore rides the assignment queue behind the refresh; let it land.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const stopped = backend.calls.filter((c) => c.cmd === 'stop_route');
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.args.pid).toBe(OWNER.pid);
    expect(state().routedPids[OWNER.pid]).toBeUndefined();
  });

  it('releases nothing when the whole device list comes back empty', async () => {
    // An empty list is how a list that has not arrived yet reads, not proof
    // that everything was unplugged: no endpoint may be released and no
    // restore may run against no hardware. The "every device of this route is
    // gone" release only speaks when there is a list to name devices with.
    const backend = installBackend({ devices: [] });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC],
      routedPids: { 1001: ['speakers'] },
      engineGenerations: { 1001: 0 },
      rememberedRoutes: [{ exeName: 'music.exe', deviceIds: ['speakers'] }],
      autoRemember: true,
    });

    await state().refreshDevices(true);
    // The restore rides the assignment queue behind the refresh; let it land.
    await new Promise((r) => setTimeout(r, 0));

    expect(backend.calls.some((c) => c.cmd === 'stop_route')).toBe(false);
    expect(backend.calls.some((c) => c.cmd === 'apply_route')).toBe(false);
    expect(state().devices).toEqual([]);
  });

  it("leaves an engine route's end to the engine, not to the device refresh", async () => {
    // A multi-device route's engine notices its devices are gone and stops
    // through `reconcile` — a refresh that also stopped it would race that
    // path with a second release. The refresh only drops the badge.
    const backend = installBackend({ devices: [TV] });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC],
      routedPids: { 1001: ['speakers', 'headphones'] },
      engineGenerations: { 1001: 5 },
    });

    await state().refreshDevices(true);

    expect(state().routedPids[1001]).toBeUndefined();
    expect(backend.calls.filter((c) => c.cmd === 'stop_route')).toHaveLength(0);
  });

  it('stays quiet when a notification changes nothing', async () => {
    installBackend();
    reset({ devices: [SPEAKERS, TV], sessions: [MUSIC] });

    await state().refreshDevices(true);

    expect(state().logs).toHaveLength(0);
  });

  it('reports a refresh that failed instead of losing the list', async () => {
    installBackend({ fail: (cmd) => cmd === 'list_devices' });
    reset({ devices: [SPEAKERS] });

    await state().refreshDevices();

    expect(state().devices).toEqual([SPEAKERS]);
    expect(lastLog()?.level).toBe('error');
    // The press is the user's own ask, and the list it wanted did not arrive.
    expect(state().errorNotice?.message).toContain('list_devices');
  });

  it('keeps a refresh the notification provoked in the log', async () => {
    // Decided rule: the channel follows who asked, not what caused the asking. An
    // unplug is something the user did, but nobody just asked this read for
    // anything — a hotplug storm of refused enumerations must not leave a card on
    // screen that says "you tried and failed".
    installBackend({ fail: (cmd) => cmd === 'list_devices' });
    reset({ devices: [SPEAKERS] });

    await state().refreshDevices(true);

    expect(lastLog()?.level).toBe('error');
    expect(state().errorNotice).toBeNull();
  });

  it('keeps the enumeration the app runs on its own in the log', async () => {
    // The boot pass reads with no argument, exactly like the Refresh button, and
    // the only thing that tells them apart is that nothing has been read yet: a
    // list that has never arrived is one of the three inputs whose order nobody
    // caused, so a machine whose very first enumeration refuses opens quietly.
    installBackend({ fail: (cmd) => cmd === 'list_devices' });
    reset({ devices: [] });

    await state().refreshDevices();

    expect(lastLog()?.level).toBe('error');
    expect(state().errorNotice).toBeNull();
    // The settings page and the board's empty panels read this, so a machine
    // with no devices is not confused with a machine nobody asked about.
    expect(state().devicesError).toContain('list_devices');
  });

  it('cannot be undone by a reconciliation asked before the unplug', async () => {
    // Judged and pinned: unlike the three other clears, the badge work in
    // `refreshDevices` needs no invalidation. A reply whose devices have all left
    // the list is dropped by reconciliation's own guard — it only rewrites a
    // route it can still name a live device for, and it hands a generation to a
    // route only when that generation is the one on screen, which the refresh has
    // just taken away. An engine-less route is not in the reply at all.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const PLAYER: AudioSession = { pid: 8701, exe_name: 'unplugged.exe' };
    const backend = installBackend({
      devices: [SPEAKERS],
      sessions: [PLAYER],
      routes: { [PLAYER.pid]: ['tv', 'headphones'] },
      routeGenerations: { [PLAYER.pid]: 7 },
      holdActive: gate,
    });
    reset({
      devices: [SPEAKERS, TV, HEADPHONES],
      sessions: [PLAYER],
      routedPids: { [PLAYER.pid]: ['tv', 'headphones'] },
      engineGenerations: { [PLAYER.pid]: 7 },
    });

    const reconciling = state().reconcileActiveDuplications();
    backend.devices = [SPEAKERS];
    await state().refreshDevices(true);
    expect(state().routedPids[PLAYER.pid]).toBeUndefined();
    release();
    await reconciling;

    expect(state().routedPids[PLAYER.pid]).toBeUndefined();
    expect(state().engineGenerations[PLAYER.pid]).toBeUndefined();
    expect(state().deviceLatencyMs).toEqual({});
    // And the engine, not the refresh, is the one that stops it.
    expect(backend.calls.some((c) => c.cmd === 'stop_route')).toBe(false);
  });
});

describe('remembered routes', () => {
  it('restores one route per program — the lowest pid of each', async () => {
    const backend = installBackend({
      sessions: [
        { pid: 2002, exe_name: 'music.exe' },
        { pid: 2001, exe_name: 'music.exe' },
      ],
      remembered: [['music.exe', ['tv']]],
    });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [
        { pid: 2002, exe_name: 'music.exe' },
        { pid: 2001, exe_name: 'music.exe' },
      ],
      rememberedRoutes: [{ exeName: 'music.exe', deviceIds: ['tv'] }],
      autoRemember: true,
    });

    await state().restoreRememberedRoutes();

    // One engine per executable: a browser with a dozen processes does not
    // need a dozen copies of the same audio.
    const applied = backend.calls.filter((c) => c.cmd === 'apply_route');
    expect(applied).toHaveLength(1);
    expect(applied[0]?.args.pid).toBe(2001);
    expect(state().routedPids[2001]).toEqual(['tv']);
  });

  it('skips remembered devices that are no longer connected', async () => {
    const backend = installBackend({
      remembered: [['music.exe', ['tv']]],
      sessions: [FRESH_MUSIC],
    });
    reset({
      devices: [SPEAKERS],
      sessions: [FRESH_MUSIC],
      rememberedRoutes: [{ exeName: 'music.exe', deviceIds: ['tv'] }],
      autoRemember: true,
    });

    await state().restoreRememberedRoutes();

    expect(backend.calls.some((c) => c.cmd === 'apply_route')).toBe(false);
    expect(state().routedPids[FRESH_MUSIC.pid]).toBeUndefined();
  });

  it('does not restore at all while auto-remember is off', async () => {
    const backend = installBackend({ sessions: [FRESH_MUSIC] });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [FRESH_MUSIC],
      rememberedRoutes: [{ exeName: 'music.exe', deviceIds: ['tv'] }],
      autoRemember: false,
    });

    await state().restoreRememberedRoutes();

    expect(backend.calls.some((c) => c.cmd === 'apply_route')).toBe(false);
    expect(state().routedPids[FRESH_MUSIC.pid]).toBeUndefined();
  });

  it('does not put back a route the user stopped by hand', async () => {
    const backend = installBackend({
      remembered: [['music.exe', ['tv']]],
      sessions: [FRESH_MUSIC],
    });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [FRESH_MUSIC],
      rememberedRoutes: [{ exeName: 'music.exe', deviceIds: ['tv'] }],
      autoRemember: true,
    });

    await state().restoreRememberedRoutes();
    expect(state().routedPids[FRESH_MUSIC.pid]).toEqual(['tv']);

    await state().stopRoute(FRESH_MUSIC.pid);
    await state().restoreRememberedRoutes();

    // A stopped route is a decision, not a failure: re-applying it on the next
    // refresh would fight the user.
    expect(backend.calls.filter((c) => c.cmd === 'apply_route')).toHaveLength(1);
    expect(state().routedPids[FRESH_MUSIC.pid]).toBeUndefined();
  });

  it('does not restore onto a program a sibling process already routes', async () => {
    // Fresh pids: the decided set is module-level. The route lives under the
    // older sibling; the lowest pid of the program must read that as "already
    // routed" rather than restore a second engine over the same audio.
    const OWNER: AudioSession = { pid: 7101, exe_name: 'sibling-music.exe' };
    const YOUNGER: AudioSession = { pid: 7100, exe_name: 'sibling-music.exe' };
    const backend = installBackend({ sessions: [OWNER, YOUNGER] });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [OWNER, YOUNGER],
      routedPids: { [OWNER.pid]: ['tv'] },
      rememberedRoutes: [{ exeName: 'sibling-music.exe', deviceIds: ['speakers'] }],
      autoRemember: true,
    });

    await state().restoreRememberedRoutes();

    expect(backend.calls.some((c) => c.cmd === 'apply_route')).toBe(false);
    expect(state().routedPids[YOUNGER.pid]).toBeUndefined();
    expect(state().routedPids[OWNER.pid]).toEqual(['tv']);
  });

  it('forgets the memory whatever spelling the row carries', async () => {
    // The backend clears case-insensitively and the memory is matched that way
    // everywhere else in the store; a spelling-sensitive filter left the row on
    // the settings list for a route the file had already dropped — and the next
    // apply wrote it straight back.
    const backend = installBackend({ remembered: [['Music.exe', ['tv']]] });
    reset({
      devices: [SPEAKERS, TV],
      rememberedRoutes: [{ exeName: 'Music.exe', deviceIds: ['tv'] }],
    });

    await state().forgetRememberedRoute('music.exe');

    expect(state().rememberedRoutes).toEqual([]);
    expect(backend.remembered).toEqual([]);
  });

  it('forgets it when the row itself is the other spelling', async () => {
    // The same rule from the opposite side: the list carries the lowercase image
    // name and the ✕ hands that row's own spelling back, so a memory written by a
    // launch that used a capital must go when asked with either spelling.
    const backend = installBackend({ remembered: [['mixer.exe', ['tv']]] });
    reset({
      devices: [SPEAKERS, TV],
      rememberedRoutes: [{ exeName: 'mixer.exe', deviceIds: ['tv'] }],
    });

    await state().forgetRememberedRoute('MIXER.EXE');

    expect(state().rememberedRoutes).toEqual([]);
    expect(backend.remembered).toEqual([]);
  });

  it('puts back only the row it could not forget', async () => {
    // The rollback of a refused forget is this executable's row, not the whole
    // list as it stood before the await: a route applied while the forget was in
    // flight wrote its memory through the backend, and restoring the old array
    // would put a stale device list back on the settings page for a program whose
    // new one is already on file.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    installBackend({
      sessions: [MUSIC, GAME],
      remembered: [
        ['music.exe', ['tv']],
        ['game.exe', ['speakers']],
      ],
      holdClear: gate,
      fail: (cmd) => cmd === 'clear_route',
    });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC, GAME],
      rememberedRoutes: [
        { exeName: 'music.exe', deviceIds: ['tv'] },
        { exeName: 'game.exe', deviceIds: ['speakers'] },
      ],
      selectedPids: [GAME.pid],
      selectedDeviceIds: ['tv'],
      autoRemember: true,
      defaultDeviceId: 'speakers',
    });

    const forgetting = state().forgetRememberedRoute('music.exe');
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The user re-routes a different program inside that window; its memory moves.
    await state().applyRoute();
    release();
    await forgetting;

    const game = state().rememberedRoutes.find((entry) => entry.exeName === 'game.exe');
    expect(game?.deviceIds).toEqual(['tv']);
    expect(state().rememberedRoutes.find((entry) => entry.exeName === 'music.exe')).toBeDefined();
  });

  it('counts a stop from a sibling as a stop of the whole program', async () => {
    // The stop is claimed by pid, but the restore pass asks each executable at
    // its *lowest* pid — and a route is the program's, held by whichever process
    // landed it. Stopping the higher sibling and claiming only that pid left the
    // program's own lowest process unclaimed, so the next refresh put the route
    // the user just took off straight back under them.
    const LOWER: AudioSession = { pid: 8101, exe_name: 'stopped-high.exe' };
    const HOLDER: AudioSession = { pid: 8102, exe_name: 'stopped-high.exe' };
    const backend = installBackend({ sessions: [LOWER, HOLDER] });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [LOWER, HOLDER],
      routedPids: { [HOLDER.pid]: ['tv'] },
      rememberedRoutes: [{ exeName: 'stopped-high.exe', deviceIds: ['tv'] }],
      autoRemember: true,
    });

    await state().stopRoute(HOLDER.pid);
    await state().restoreRememberedRoutes();

    expect(backend.calls.filter((c) => c.cmd === 'apply_route')).toHaveLength(0);
    expect(state().routedPids).toEqual({});
  });

  it('counts a batch stop as a stop of every program it took down', async () => {
    const LOWER: AudioSession = { pid: 8111, exe_name: 'stopped-batch.exe' };
    const HOLDER: AudioSession = { pid: 8112, exe_name: 'stopped-batch.exe' };
    const backend = installBackend({ sessions: [LOWER, HOLDER] });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [LOWER, HOLDER],
      routedPids: { [HOLDER.pid]: ['tv'] },
      rememberedRoutes: [{ exeName: 'stopped-batch.exe', deviceIds: ['tv'] }],
      autoRemember: true,
    });

    await state().stopAllRoutes();
    await state().restoreRememberedRoutes();

    expect(backend.calls.filter((c) => c.cmd === 'apply_route')).toHaveLength(0);
    expect(state().routedPids).toEqual({});
  });

  it('lets a route the user applied win over a restore that answers late', async () => {
    // The restore picks its targets, then awaits the backend — and the pinning
    // itself raises a Core Audio change, so a refresh (or a hand route) lands
    // inside that window. Committing the pre-await picture over the newer route
    // would show devices the engine is not playing and, worse, put the restore's
    // generation on the live engine, so every event it later sends reads stale.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const LATE: AudioSession = { pid: 8121, exe_name: 'late-restore.exe' };
    const backend = installBackend({ sessions: [LATE], holdRestore: gate });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [LATE],
      rememberedRoutes: [{ exeName: 'late-restore.exe', deviceIds: ['tv'] }],
      autoRemember: true,
      selectedPids: [LATE.pid],
      selectedDeviceIds: ['speakers'],
      // The default is the TV, so the staged Speakers plan is a proposal the
      // hub can land. A plan that only names the system default is never
      // pressable — `applyRoute` skips it — and staging this race against an
      // unpressable plan would test nothing.
      defaultDeviceId: 'tv',
    });

    const restoring = state().restoreRememberedRoutes();
    // Both routes are single-device, so neither has an engine to reconcile them
    // back: the badge is the store's own to get right.
    await state().applyRoute();
    release();
    await restoring;

    expect(state().routedPids[LATE.pid]).toEqual(['speakers']);
    const applied = backend.calls.filter((c) => c.cmd === 'apply_route');
    expect(applied[applied.length - 1]?.args).toMatchObject({ deviceIds: ['speakers'] });
  });
});

describe('settings and log', () => {
  it('caps the log so a chatty session cannot grow it without bound', () => {
    installBackend();
    reset();

    for (let i = 0; i < 260; i += 1) state().addLog(`entry ${i}`);

    expect(state().logs.length).toBe(200);
    // Newest last: the oldest entries are the ones that fell off.
    expect(state().logs[state().logs.length - 1]?.message).toBe('entry 259');
  });

  it('raises a failure where the user is looking, and in the log', () => {
    installBackend();
    reset();

    state().raiseError('apply_route failed');

    expect(state().errorNotice?.message).toBe('apply_route failed');
    expect(lastLog()?.level).toBe('error');

    // One notice at a time, keyed on a counter: a second failure replaces the
    // first, and the identical text still counts as a new arrival so the
    // countdown restarts rather than expiring under a message that just came in.
    const first = state().errorNotice?.id;
    state().raiseError('apply_route failed');
    expect(state().errorNotice?.id).not.toBe(first);

    state().dismissError();
    expect(state().errorNotice).toBeNull();
  });

  it('clamps a delay past the hard bound before storing it', async () => {
    installBackend();
    reset({ deviceDelays: {} });

    await state().setDeviceDelayValue('tv', 99_999);

    expect(state().deviceDelays.tv).toBe(10_000);
  });

  it('prunes a delay of 0 instead of storing it', async () => {
    // A delay of 0 is an absence, not a value: like the neutral source level
    // and the neutral share, it must have exactly one representation — the
    // missing key that every reader already treats as 0. The backend still
    // gets the write, so its file sheds the entry with the store.
    const backend = installBackend();
    reset({ devices: [SPEAKERS, TV], deviceDelays: { tv: 150 } });

    await state().setDeviceDelayValue('tv', 0);

    expect('tv' in state().deviceDelays).toBe(false);
    expect(
      backend.calls.some((call) => call.cmd === 'set_device_delay' && call.args.delayMs === 0),
    ).toBe(true);
  });

  it('reads a stored 0 back as no entry at all', async () => {
    // A file written by a build that stored the neutral value must not
    // smuggle that shape back in: the read prunes it the write would have.
    installBackend({
      delays: [
        ['tv', 0],
        ['speakers', 40],
      ],
    });
    reset();

    await state().loadDelaySettings();

    expect(state().deviceDelays).toEqual({ speakers: 40 });
  });

  it('answers the calibration walk in booleans: accepted true, refused false', async () => {
    // The calibration's apply walks every measured device and stops at the
    // first `false`, keeping the results screen up to say so — the boolean is
    // the only failure signal that walk has.
    const backend = installBackend({ fail: (cmd) => cmd === 'set_device_delay' });
    reset({ devices: [SPEAKERS, TV], deviceDelays: {} });

    // A refusal rolls the optimistic write back and answers false.
    await expect(state().setDeviceDelayValue('tv', 30)).resolves.toBe(false);
    expect(state().deviceDelays.tv).toBeUndefined();
    expect(lastLog()?.level).toBe('error');

    // The retry the results screen offers is just another call: once the
    // backend takes the value the same request answers true.
    backend.fail = () => false;
    await expect(state().setDeviceDelayValue('tv', 30)).resolves.toBe(true);
    expect(state().deviceDelays.tv).toBe(30);
    expect(backend.calls.filter((c) => c.cmd === 'set_device_delay')).toHaveLength(2);
  });

  it('answers true without asking the backend when the value does not change', async () => {
    // Same value is a success, not a refusal: a falsy answer would stop the
    // calibration's apply walk dead over nothing.
    const backend = installBackend();
    reset({ devices: [SPEAKERS, TV], deviceDelays: { tv: 40 } });

    await expect(state().setDeviceDelayValue('tv', 40)).resolves.toBe(true);
    expect(backend.calls.some((c) => c.cmd === 'set_device_delay')).toBe(false);
  });

  it('writes calibrated delays without touching the live route', async () => {
    // The calibration is the settings page adjusting what each device owns; a
    // running route is the board's to land. When the new delays move the
    // primary seat, the board previews it and the hub asks — writing the
    // values must never reorder the route behind the user's back.
    const backend = installBackend({
      devices: [SPEAKERS, TV, HEADPHONES],
      routes: { 1001: ['speakers', 'headphones'] },
    });
    reset({ sessions: [MUSIC], routedPids: { 1001: ['speakers', 'headphones'] } });

    await state().setDeviceDelayValue('headphones', 0);
    await state().setDeviceDelayValue('speakers', 120);

    expect(backend.calls.some((c) => c.cmd === 'apply_route')).toBe(false);
    expect(state().routedPids[1001]).toEqual(['speakers', 'headphones']);
    expect(state().deviceDelays.speakers).toBe(120);
  });

  it('leaves a newer share standing when an older click is refused', async () => {
    // Same shape as the primary volume above: the copy's share stepper fires
    // without waiting, so an older rejection rolling back over a newer accepted
    // value would leave the board naming a level the engine is not applying.
    installBackend({ fail: (cmd, args) => cmd === 'set_device_volume' && args.percent === 60 });
    reset({ devices: [SPEAKERS, TV] });

    const older = state().setDeviceVolume('tv', 60);
    await state().setDeviceVolume('tv', 55);
    await older;

    expect(state().deviceVolumes.tv).toBe(55);
  });

  it('leaves a newer level standing when an older commit is refused', async () => {
    installBackend({ fail: (cmd, args) => cmd === 'set_source_volume' && args.percent === 300 });
    reset({ devices: [SPEAKERS], sessions: [MUSIC] });

    const older = state().setSourceVolume('music.exe', 300);
    await state().setSourceVolume('music.exe', 250);
    await older;

    expect(state().sourceVolumes['music.exe']).toBe(250);
  });

  it('leaves a newer delay standing when an older click is refused', async () => {
    installBackend({ fail: (cmd, args) => cmd === 'set_device_delay' && args.delayMs === 30 });
    reset({ devices: [SPEAKERS, TV] });

    const older = state().setDeviceDelayValue('tv', 30);
    await state().setDeviceDelayValue('tv', 40);
    await older;

    expect(state().deviceDelays.tv).toBe(40);
  });

  it('persists the auto-remember switch', () => {
    installBackend();
    reset({ autoRemember: true });

    state().toggleAutoRemember();
    expect(state().autoRemember).toBe(false);
    expect(localStorage.getItem('aar-auto-remember')).toBe('0');

    state().toggleAutoRemember();
    expect(state().autoRemember).toBe(true);
    expect(localStorage.getItem('aar-auto-remember')).toBe('1');
  });
});

describe('feeds', () => {
  it('stages a programme input on the plan, and the hub lands it', async () => {
    const backend = installBackend();
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC, GAME],
      feedCarrier: backend.carrier,
      defaultDeviceId: 'speakers',
    });
    state().selectProcess(MUSIC.pid);
    state().appendFeedTarget(GAME.pid);

    // Staged, not connected: the plan holds the pair and nothing has been asked
    // of the backend yet. The plan also already names the system default the
    // program plays through — a guess, not a route.
    expect(state().selectedFeedPids).toEqual([GAME.pid]);
    expect(state().selectedDeviceIds).toEqual(['speakers']);
    expect(state().feeds[MUSIC.pid]).toBeUndefined();
    expect(backend.calls.some((call) => call.cmd === 'set_feed_target')).toBe(false);

    await state().applyRoute();

    expect(state().feeds[MUSIC.pid]).toEqual([GAME.pid]);
    expect(state().rememberedFeeds).toEqual([{ sourceExe: 'music.exe', targetExe: ['game.exe'] }]);
    // A feeds-only press writes no route: the device plan named what the
    // program already plays through, so `apply_route` never ran.
    expect(backend.calls.some((call) => call.cmd === 'apply_route')).toBe(false);

    // The way back out is the same two beats: stage the removal, land it.
    state().dropFeedTarget(GAME.pid);
    expect(state().feeds[MUSIC.pid]).toEqual([GAME.pid]);
    await state().applyRoute();
    expect(backend.calls.some((call) => call.cmd === 'remove_feed_target')).toBe(true);
    expect(state().feeds[MUSIC.pid]).toBeUndefined();
    expect(state().rememberedFeeds).toEqual([]);
  });

  it('lands a feed with no carrier as recorded-but-silent, and says so', async () => {
    installBackend({ carrier: { render: null, capture: null } });
    reset({ devices: [SPEAKERS, TV], sessions: [MUSIC, GAME] });
    state().selectProcess(MUSIC.pid);
    state().appendFeedTarget(GAME.pid);

    await state().applyRoute();

    // The rule is the user's decision and stays; nothing moves until a pair is
    // picked in the settings, and the log says exactly that.
    expect(state().feeds[MUSIC.pid]).toEqual([GAME.pid]);
    expect(state().rememberedFeeds).toHaveLength(1);
    expect(lastLog()?.message).toContain('no carrier');
    expect(lastLog()?.level).toBe('error');
  });

  it('rolls a refused feed out of the live map, and keeps the plan staged for a retry', async () => {
    installBackend({ fail: (cmd) => cmd === 'set_feed_target' });
    reset({ devices: [SPEAKERS, TV], sessions: [MUSIC, GAME] });
    state().selectProcess(MUSIC.pid);
    state().appendFeedTarget(GAME.pid);

    await state().applyRoute();

    expect(state().feeds[MUSIC.pid]).toBeUndefined();
    expect(state().rememberedFeeds).toEqual([]);
    expect(lastLog()?.level).toBe('error');
    // The plan stands exactly as staged: the hub keeps asking, and the next
    // press retries precisely what failed.
    expect(state().selectedFeedPids).toEqual([GAME.pid]);
    expect(state().feedSelectionPrefilled).toBe(false);
  });

  it('keeps a feed only while both of its ends are on the session list', async () => {
    installBackend({ sessions: [MUSIC, GAME] });
    reset({
      devices: [SPEAKERS, TV],
      rememberedFeeds: [{ sourceExe: 'music.exe', targetExe: ['game.exe'] }],
      feeds: {},
    });

    await state().refreshSessions();
    expect(state().feeds[MUSIC.pid]).toEqual([GAME.pid]);

    // The target exits: the wire has nothing to arrive at, and the card goes
    // with it — the rule itself stays in the memory.
    installBackend({ sessions: [MUSIC] });
    await state().refreshSessions();
    expect(state().feeds[MUSIC.pid]).toBeUndefined();
    expect(state().rememberedFeeds).toHaveLength(1);
  });

  it('refuses to stage a feed into the programme itself', async () => {
    installBackend();
    reset({ devices: [SPEAKERS, TV], sessions: [MUSIC, GAME] });
    state().selectProcess(MUSIC.pid);

    state().appendFeedTarget(MUSIC.pid);

    expect(state().selectedFeedPids).toEqual([]);
    expect(state().rememberedFeeds).toEqual([]);
  });

  it('delivers remembered feeds again after a restart — the board is not delivery', async () => {
    // Fresh names: the restore-decided set lives at module level, and a pair
    // an earlier test added was claimed by that add.
    const RESTORED_MUSIC: AudioSession = { pid: 6101, exe_name: 'restore-music.exe' };
    const RESTORED_GAME: AudioSession = { pid: 6102, exe_name: 'restore-game.exe' };
    const backend = installBackend({
      sessions: [RESTORED_MUSIC, RESTORED_GAME],
      feeds: [['restore-music.exe', 'restore-game.exe']],
      carrier: { render: 'speakers', capture: 'cable-out' },
    });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [RESTORED_MUSIC, RESTORED_GAME],
      feedCarrier: { render: 'speakers', capture: 'cable-out' },
    });

    // The boot sequence: the memory arrives with the lists already in place.
    // The feed map the board reads is derived from this very memory, so its
    // membership must not be read as "already delivered" — the endpoints have
    // to be pinned again or the card says 送入 while nothing moves.
    // `loadFeeds` fires the restore without waiting on it; give it a tick.
    await state().loadFeeds();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      backend.calls.some(
        (call) =>
          call.cmd === 'set_feed_target' &&
          call.args.sourcePid === RESTORED_MUSIC.pid &&
          call.args.targetPid === RESTORED_GAME.pid,
      ),
    ).toBe(true);
    expect(state().feeds[RESTORED_MUSIC.pid]).toEqual([RESTORED_GAME.pid]);
    expect(lastLog()?.message).toContain('restore-music.exe');
  });

  it('does not re-pin a feed the hub landed this run when a refresh comes by', async () => {
    const backend = installBackend();
    reset({ devices: [SPEAKERS, TV], sessions: [MUSIC, GAME], feedCarrier: backend.carrier });
    state().selectProcess(MUSIC.pid);
    state().appendFeedTarget(GAME.pid);
    await state().applyRoute();
    const asksAfterAdd = backend.calls.filter((c) => c.cmd === 'set_feed_target').length;

    // A Core Audio change arrives; the restore pass runs with it. The feed
    // was delivered when it landed, so the pass has nothing to do here.
    await state().refreshSessions();

    expect(backend.calls.filter((c) => c.cmd === 'set_feed_target')).toHaveLength(asksAfterAdd);
    expect(state().feeds[MUSIC.pid]).toEqual([GAME.pid]);
  });

  it('keeps one wire when a sibling process stages or drops it', async () => {
    // The live feed map is the program's, rebuilt on its lowest pid, and the
    // board can be looking at any process of it. A plan staged under the
    // sibling's pid gave one rule two addresses: the hub would land a second
    // wire, and the ✕ pressed from that board would find nothing.
    const BROWSER_MAIN: AudioSession = { pid: 6301, exe_name: 'sibling-browser.exe' };
    const BROWSER_TAB: AudioSession = { pid: 6302, exe_name: 'sibling-browser.exe' };
    const RECEIVER: AudioSession = { pid: 6303, exe_name: 'receiver.exe' };
    const backend = installBackend({ sessions: [BROWSER_MAIN, BROWSER_TAB, RECEIVER] });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [BROWSER_TAB, RECEIVER, BROWSER_MAIN],
      feedCarrier: backend.carrier,
    });

    // The board is on the tab; the rule lands under the program's lowest pid.
    state().selectProcess(BROWSER_TAB.pid);
    state().appendFeedTarget(RECEIVER.pid);
    await state().applyRoute();

    expect(state().feeds[BROWSER_MAIN.pid]).toEqual([RECEIVER.pid]);
    expect(state().feeds[BROWSER_TAB.pid]).toBeUndefined();
    expect(backend.calls.find((call) => call.cmd === 'set_feed_target')?.args).toMatchObject({
      sourcePid: BROWSER_MAIN.pid,
      targetPid: RECEIVER.pid,
    });

    // Same for the way out: dropped from the tab's plan, landed from there.
    state().dropFeedTarget(RECEIVER.pid);
    await state().applyRoute();

    expect(state().feeds[BROWSER_MAIN.pid]).toBeUndefined();
    expect(
      backend.calls.some(
        (call) => call.cmd === 'remove_feed_target' && call.args.sourcePid === BROWSER_MAIN.pid,
      ),
    ).toBe(true);
  });

  it('puts a refused removal back where the wire stood, not at the end', async () => {
    // The amber rows are numbered in this array's order, and the array is
    // rebuilt from the memory on every refresh. Appending the wire back after a
    // refused removal therefore renumbered the feeds the user still had
    // standing — on the board at once, and on the next refresh through the
    // memory as well.
    const SENDER: AudioSession = { pid: 6501, exe_name: 'sender.exe' };
    const ONE: AudioSession = { pid: 6502, exe_name: 'one.exe' };
    const TWO: AudioSession = { pid: 6503, exe_name: 'two.exe' };
    const THREE: AudioSession = { pid: 6504, exe_name: 'three.exe' };
    installBackend({
      sessions: [SENDER, ONE, TWO, THREE],
      fail: (cmd, args) => cmd === 'remove_feed_target' && args.targetPid === TWO.pid,
    });
    reset({
      devices: [SPEAKERS],
      sessions: [SENDER, ONE, TWO, THREE],
      feeds: { [SENDER.pid]: [ONE.pid, TWO.pid, THREE.pid] },
      rememberedFeeds: [
        { sourceExe: 'sender.exe', targetExe: ['one.exe', 'two.exe', 'three.exe'] },
      ],
    });
    state().selectProcess(SENDER.pid);

    state().dropFeedTarget(TWO.pid);
    await state().applyRoute();

    expect(state().feeds[SENDER.pid]).toEqual([ONE.pid, TWO.pid, THREE.pid]);
    expect(state().rememberedFeeds[0]?.targetExe).toEqual(['one.exe', 'two.exe', 'three.exe']);

    // And it stays put through the refresh that rebuilds the board from the
    // memory: the order the user set is the order the next frame draws.
    await state().refreshSessions();
    expect(state().feeds[SENDER.pid]).toEqual([ONE.pid, TWO.pid, THREE.pid]);
  });

  it('reads a feed as moving sound beside a route, and only a broken tap as held', () => {
    // A feed used to cost the programme its output: the per-app render slot is
    // one per executable, so a device route and a feed could not coexist. The
    // wire is now a tap inside the engine instead, and what makes a feed read as
    // held is the tap failing — not a route existing.
    const carrier = { render: 'cable-in', capture: 'cable-out' };

    expect(feedLiveness('browser.exe', carrier, {})).toBe('live');
    expect(feedLiveness('Browser.exe', carrier, {})).toBe('live');
    expect(feedLiveness('browser.exe', { render: null, capture: null }, {})).toBe('no-carrier');
    expect(feedLiveness('Browser.exe', carrier, { 'browser.exe': 'the endpoint left' })).toBe(
      'suspended',
    );
  });

  it('claims a feed the moment the hub asks, so the refresh its pinning causes cannot pin it twice', async () => {
    // Pinning both ends is itself a Core Audio change: the notification it
    // raises runs the feed restore while the landing's own reply is still in
    // the air. Claiming only when the reply arrives left that pass free to
    // deliver the same rule again and log a feed the user just made as
    // restored.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const SOURCE: AudioSession = { pid: 8201, exe_name: 'held-source.exe' };
    const TARGET: AudioSession = { pid: 8202, exe_name: 'held-target.exe' };
    const backend = installBackend({
      sessions: [SOURCE, TARGET],
      carrier: { render: 'cable-in', capture: 'cable-out' },
      holdFeed: gate,
    });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [SOURCE, TARGET],
      feedCarrier: { render: 'cable-in', capture: 'cable-out' },
    });
    state().selectProcess(SOURCE.pid);
    state().appendFeedTarget(TARGET.pid);

    const landing = state().applyRoute();
    const restoring = state().restoreRememberedFeeds();
    release();
    await Promise.all([landing, restoring]);

    expect(backend.calls.filter((c) => c.cmd === 'set_feed_target')).toHaveLength(1);
    expect(state().feeds[SOURCE.pid]).toEqual([TARGET.pid]);
  });

  it('hands a feed that came back undelivered back to the restore pass', async () => {
    // The claim is only for a delivery. A rule that could not move has to stay
    // restorable, or the pass that runs when its reason clears (the carrier
    // gets paired, the source's route stops) would walk past it forever.
    const SOURCE: AudioSession = { pid: 8211, exe_name: 'suspended-source.exe' };
    const TARGET: AudioSession = { pid: 8212, exe_name: 'suspended-target.exe' };
    const backend = installBackend({
      sessions: [SOURCE, TARGET],
      carrier: { render: null, capture: null },
    });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [SOURCE, TARGET],
      feedCarrier: { render: null, capture: null },
    });
    state().selectProcess(SOURCE.pid);
    state().appendFeedTarget(TARGET.pid);

    await state().applyRoute();
    expect(backend.calls.filter((c) => c.cmd === 'set_feed_target')).toHaveLength(1);

    backend.carrier = { render: 'cable-in', capture: 'cable-out' };
    await state().loadFeedCarrier();
    // The restore rides the assignment queue behind the carrier read.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(backend.calls.filter((c) => c.cmd === 'set_feed_target')).toHaveLength(2);
    expect(state().feeds[SOURCE.pid]).toEqual([TARGET.pid]);
  });

  it('leaves a pairing that landed standing when an earlier one is refused', async () => {
    // The two picker rows write the carrier without waiting, so a first pairing can
    // be refused after a second has already been accepted — and a rollback of the
    // whole pair would put the store back on endpoints the file no longer holds,
    // which is what every feed's liveness is read from.
    installBackend({
      carrier: { render: 'cable-in', capture: null },
      fail: (cmd, args) => cmd === 'set_feed_carrier' && args.render === 'cable-in',
    });
    reset({ devices: [SPEAKERS, TV], feedCarrier: { render: 'cable-in', capture: null } });

    const first = state().setFeedCarrier('cable-in', 'cable-out');
    const second = state().setFeedCarrier('speakers', 'cable-out');
    await Promise.all([first, second]);

    expect(state().feedCarrier).toEqual({ render: 'speakers', capture: 'cable-out' });
    // And the refusal is still said out loud: the user did ask for that one.
    expect(state().errorNotice?.message).toContain('set_feed_carrier');
  });

  it('leaves a feed standing when the route it was added beside stops', async () => {
    // A feed is the engine's tap into the carrier, and the backend puts that tap
    // back on an engine of its own when the route's engine goes down. The store
    // must therefore neither drop the wire nor ask for it again: re-delivering
    // here would restart the engine that just stopped.
    const SOURCE: AudioSession = { pid: 8601, exe_name: 'held-slot-source.exe' };
    const TARGET: AudioSession = { pid: 8602, exe_name: 'held-slot-target.exe' };
    const backend = installBackend({
      sessions: [SOURCE, TARGET],
      routes: { [SOURCE.pid]: ['tv'] },
      carrier: { render: 'cable-in', capture: 'cable-out' },
      remembered: [['held-slot-source.exe', ['tv']]],
      feeds: [['held-slot-source.exe', 'held-slot-target.exe']],
    });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [SOURCE, TARGET],
      routedPids: { [SOURCE.pid]: ['tv'] },
      engineGenerations: { [SOURCE.pid]: 0 },
      feedCarrier: { render: 'cable-in', capture: 'cable-out' },
      rememberedFeeds: [{ sourceExe: 'held-slot-source.exe', targetExe: ['held-slot-target.exe'] }],
      feeds: { [SOURCE.pid]: [TARGET.pid] },
      rememberedRoutes: [{ exeName: 'held-slot-source.exe', deviceIds: ['tv'] }],
      autoRemember: true,
    });

    // A board that is already carrying this wire has claimed the pair, so the
    // stop below is the only thing that could ask for it again.
    await state().restoreRememberedFeeds();
    const asksBeforeStop = backend.calls.filter((c) => c.cmd === 'set_feed_target').length;
    expect(asksBeforeStop).toBe(1);

    await state().stopRoute(SOURCE.pid);

    expect(state().routedPids[SOURCE.pid]).toBeUndefined();
    expect(state().feeds[SOURCE.pid]).toEqual([TARGET.pid]);
    expect(backend.calls.some((c) => c.cmd === 'remove_feed_target')).toBe(false);
    expect(backend.feeds).toEqual([['held-slot-source.exe', 'held-slot-target.exe']]);
    expect(backend.calls.filter((c) => c.cmd === 'set_feed_target')).toHaveLength(asksBeforeStop);

    // The route the user just stopped must not come back and take the slot again,
    // and the pass a refresh provokes has nothing left to deliver.
    await state().restoreRememberedRoutes();
    expect(backend.calls.filter((c) => c.cmd === 'apply_route')).toHaveLength(0);

    await state().restoreRememberedFeeds();
    expect(backend.calls.filter((c) => c.cmd === 'set_feed_target')).toHaveLength(asksBeforeStop);
    expect(state().feeds[SOURCE.pid]).toEqual([TARGET.pid]);
  });

  it('lands a feed and a route from the same press, and keeps the feed when the route stops', async () => {
    // One press, two plans: the staged route and the staged feed land together,
    // and the landing's ask and the engine's start overlap. A feed no longer
    // waits on the programme's output slot, so the answer is a delivery either
    // way — and the route stopping later must not turn it into a second ask.
    let releaseFeed: () => void = () => {};
    const feedGate = new Promise<void>((resolve) => {
      releaseFeed = resolve;
    });
    const SOURCE: AudioSession = { pid: 8611, exe_name: 'midflight-source.exe' };
    const TARGET: AudioSession = { pid: 8612, exe_name: 'midflight-target.exe' };
    const backend = installBackend({
      sessions: [SOURCE, TARGET],
      carrier: { render: 'cable-in', capture: 'cable-out' },
      holdFeed: feedGate,
    });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [SOURCE, TARGET],
      feedCarrier: { render: 'cable-in', capture: 'cable-out' },
      defaultDeviceId: 'speakers',
    });
    state().selectProcess(SOURCE.pid);
    state().appendFeedTarget(TARGET.pid);
    // Naming another device replaces the prefilled guess: the route is the
    // user's own staging, landed by the same press as the feed.
    state().toggleDeviceSelection('tv');

    const landing = state().applyRoute();
    releaseFeed();
    await landing;

    expect(state().feeds[SOURCE.pid]).toEqual([TARGET.pid]);
    expect(state().routedPids[SOURCE.pid]).toEqual(['tv']);
    expect(backend.feeds).toEqual([['midflight-source.exe', 'midflight-target.exe']]);
    expect(feedLiveness('midflight-source.exe', state().feedCarrier, state().feedTapFailures)).toBe(
      'live',
    );

    // The route stops: the feed is the backend's to keep, and nothing here asks
    // for it a second time.
    await state().stopRoute(SOURCE.pid);
    await state().restoreRememberedFeeds();
    expect(backend.calls.filter((c) => c.cmd === 'set_feed_target')).toHaveLength(1);
    expect(state().feeds[SOURCE.pid]).toEqual([TARGET.pid]);
  });

  it('hands the claim back when the landing itself is refused', async () => {
    // The catch path is the third exit of the claim (delivered / undelivered /
    // rejected). The rule goes back out of the memory with it, so nothing can be
    // re-delivered for a pair the audio service never accepted — but the claim
    // must not stay standing either: the next time the user presses the hub it
    // has to be asked for, and asked for once.
    const SOURCE: AudioSession = { pid: 8621, exe_name: 'refused-source.exe' };
    const TARGET: AudioSession = { pid: 8622, exe_name: 'refused-target.exe' };
    const backend = installBackend({
      sessions: [SOURCE, TARGET],
      carrier: { render: 'cable-in', capture: 'cable-out' },
    });
    backend.fail = (cmd) => cmd === 'set_feed_target';
    reset({
      devices: [SPEAKERS, TV],
      sessions: [SOURCE, TARGET],
      feedCarrier: { render: 'cable-in', capture: 'cable-out' },
    });
    state().selectProcess(SOURCE.pid);
    state().appendFeedTarget(TARGET.pid);

    await state().applyRoute();
    expect(state().feeds[SOURCE.pid]).toBeUndefined();
    expect(state().rememberedFeeds).toEqual([]);
    expect(backend.feeds).toEqual([]);

    // The same press again, and this time it lands.
    backend.fail = () => false;
    await state().applyRoute();
    expect(state().feeds[SOURCE.pid]).toEqual([TARGET.pid]);
    const asks = backend.calls.filter((c) => c.cmd === 'set_feed_target');
    expect(asks).toHaveLength(2);

    // Delivered: the pass a refresh provokes has nothing left to do here.
    await state().refreshSessions();
    expect(backend.calls.filter((c) => c.cmd === 'set_feed_target')).toHaveLength(2);
  });

  it('keeps the plan tracking the live feeds until the user stages one of their own', async () => {
    // The board can open before the memory arrives: the plan starts empty, and
    // a restore landing afterwards must not read as a proposal waiting for the
    // hub — a press on that hub would take down a feed the user never touched.
    const backend = installBackend();
    reset({ devices: [SPEAKERS, TV], sessions: [MUSIC, GAME], feedCarrier: backend.carrier });
    state().selectProcess(MUSIC.pid);
    expect(state().selectedFeedPids).toEqual([]);

    backend.feeds = [['music.exe', 'game.exe']];
    await state().loadFeeds();
    // The restore rides the assignment queue behind the memory read.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state().feeds[MUSIC.pid]).toEqual([GAME.pid]);
    expect(state().selectedFeedPids).toEqual([GAME.pid]);
  });
});

describe('missing icons', () => {
  // Fresh executable names: the retry budget lives at module level on
  // purpose, so a name another test missed already carries spent tries.
  const ICONLESS: AudioSession = { pid: 5001, exe_name: 'iconless.exe' };
  const DEPARTED: AudioSession = { pid: 5002, exe_name: 'departed.exe' };

  it('asks again on its own when a miss settles — a quiet system has no refresh to lean on', async () => {
    vi.useFakeTimers();
    try {
      const backend = installBackend({ sessions: [ICONLESS] });
      reset({ sessions: [ICONLESS] });

      await state().refreshSessions();
      const asks = () => backend.calls.filter((c) => c.cmd === 'get_process_icon').length;
      expect(asks()).toBe(1);

      // 2s, 4s, 8s — three self-retries, then the executable waits for a real
      // refresh like it always did.
      await vi.advanceTimersByTimeAsync(2000);
      expect(asks()).toBe(2);
      await vi.advanceTimersByTimeAsync(4000);
      expect(asks()).toBe(3);
      await vi.advanceTimersByTimeAsync(8000);
      expect(asks()).toBe(4);
      await vi.advanceTimersByTimeAsync(16000);
      expect(asks()).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the retry when the executable leaves the list', async () => {
    vi.useFakeTimers();
    try {
      const backend = installBackend({ sessions: [DEPARTED] });
      reset({ sessions: [DEPARTED] });

      await state().refreshSessions();
      const asks = () => backend.calls.filter((c) => c.cmd === 'get_process_icon').length;
      expect(asks()).toBe(1);

      installBackend({ sessions: [] });
      await state().refreshSessions();
      await vi.advanceTimersByTimeAsync(8000);
      expect(asks()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('stop of every route', () => {
  it('takes a stopped program’s siblings out of the selection too', async () => {
    // The batch clears the route table, but the selection is drawn per process:
    // a sibling of one of those programs left standing keeps a stopped plan on
    // the board with no route under it left to stop.
    const SIBLING: AudioSession = { pid: 1013, exe_name: 'music.exe' };
    installBackend();
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC, SIBLING, GAME],
      selectedPids: [SIBLING.pid],
      selectedDeviceIds: ['speakers', 'tv'],
      routedPids: { [MUSIC.pid]: ['speakers', 'tv'] },
    });

    await state().stopAllRoutes();

    expect(state().routedPids).toEqual({});
    expect(state().selectedPids).toEqual([]);
    expect(state().selectedDeviceIds).toEqual([]);
  });

  it('keeps the selection of a program it was not routing', async () => {
    installBackend();
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC, GAME],
      selectedPids: [GAME.pid],
      selectedDeviceIds: ['speakers', 'tv'],
      routedPids: { [MUSIC.pid]: ['speakers', 'tv'] },
    });

    await state().stopAllRoutes();

    expect(state().selectedPids).toEqual([GAME.pid]);
    expect(state().selectedDeviceIds).toEqual(['speakers', 'tv']);
  });

  it('does not let a reconciliation asked before the batch stop put them all back', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const PLAYER: AudioSession = { pid: 8311, exe_name: 'reconciled-batch.exe' };
    installBackend({
      sessions: [PLAYER],
      routes: { [PLAYER.pid]: ['speakers', 'tv'] },
      routeGenerations: { [PLAYER.pid]: 2 },
      holdActive: gate,
    });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [PLAYER],
      routedPids: { [PLAYER.pid]: ['speakers', 'tv'] },
      engineGenerations: { [PLAYER.pid]: 2 },
    });

    const reconciling = state().reconcileActiveDuplications();
    await state().stopAllRoutes();
    release();
    await reconciling;

    expect(state().routedPids).toEqual({});
    expect(state().engineGenerations).toEqual({});
  });

  it('does not let a reconciliation asked during the batch put any of them back', async () => {
    // The batch's second move, and both halves of it: an answer that lands *while*
    // the stops are being processed has already drawn the engines back, which only
    // the retirement of the generation each retired engine wore can take away — and
    // an ask made in the same window is retired too, so a reply that comes in after
    // the batch cannot revive the route a second time.
    let releaseStop: () => void = () => {};
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const FIRST: AudioSession = { pid: 8351, exe_name: 'batch-mid-first.exe' };
    const SECOND: AudioSession = { pid: 8352, exe_name: 'batch-mid-second.exe' };
    installBackend({
      sessions: [FIRST, SECOND],
      routes: { [FIRST.pid]: ['speakers', 'tv'], [SECOND.pid]: ['speakers', 'tv'] },
      routeGenerations: { [FIRST.pid]: 1, [SECOND.pid]: 2 },
      holdStop: stopGate,
    });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [FIRST, SECOND],
      routedPids: { [FIRST.pid]: ['speakers', 'tv'], [SECOND.pid]: ['speakers', 'tv'] },
      engineGenerations: { [FIRST.pid]: 1, [SECOND.pid]: 2 },
    });

    const stopping = state().stopAllRoutes();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await state().reconcileActiveDuplications();
    expect(state().routedPids[FIRST.pid]).toEqual(['speakers', 'tv']);

    releaseStop();
    await stopping;

    expect(state().routedPids).toEqual({});
    expect(state().engineGenerations).toEqual({});
  });

  it('does not let an answer that arrives after the batch revive any of them', async () => {
    // The batch's second retirement on its own: an ask made while the stops are
    // being processed, whose answer only comes in afterwards. Nothing is left to
    // take back by then — the take-down has run against a badge that was never
    // written — so this reply has to be refused, not undone.
    let releaseAsk: () => void = () => {};
    const askGate = new Promise<void>((resolve) => {
      releaseAsk = resolve;
    });
    let releaseStop: () => void = () => {};
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const FIRST: AudioSession = { pid: 8353, exe_name: 'batch-late-first.exe' };
    const SECOND: AudioSession = { pid: 8354, exe_name: 'batch-late-second.exe' };
    installBackend({
      sessions: [FIRST, SECOND],
      routes: { [FIRST.pid]: ['speakers', 'tv'], [SECOND.pid]: ['speakers', 'tv'] },
      routeGenerations: { [FIRST.pid]: 3, [SECOND.pid]: 3 },
      holdActive: askGate,
      holdStop: stopGate,
    });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [FIRST, SECOND],
      routedPids: { [FIRST.pid]: ['speakers', 'tv'], [SECOND.pid]: ['speakers', 'tv'] },
      engineGenerations: { [FIRST.pid]: 3, [SECOND.pid]: 3 },
    });

    const stopping = state().stopAllRoutes();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const lateAnswer = state().reconcileActiveDuplications();
    releaseStop();
    await stopping;
    releaseAsk();
    await lateAnswer;

    expect(state().routedPids).toEqual({});
    expect(state().engineGenerations).toEqual({});
  });

  it('claims a program that holds two routes in two of its own processes', async () => {
    // Two badges for one executable is a shape the engine list can hand the store
    // (routes that outlasted a reload, a fold that came apart before this run).
    // The batch stops both, and the claim has to reach the program's *lowest*
    // process — the one nobody routed — or the next pass puts the memory back on
    // a process the user never even saw.
    const LOW: AudioSession = { pid: 8801, exe_name: 'two-badges.exe' };
    const MID: AudioSession = { pid: 8802, exe_name: 'two-badges.exe' };
    const HIGH: AudioSession = { pid: 8803, exe_name: 'two-badges.exe' };
    const backend = installBackend({
      sessions: [LOW, MID, HIGH],
      routes: { [MID.pid]: ['speakers', 'tv'], [HIGH.pid]: ['tv'] },
      routeGenerations: { [MID.pid]: 2 },
    });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [LOW, MID, HIGH],
      routedPids: { [MID.pid]: ['speakers', 'tv'], [HIGH.pid]: ['tv'] },
      engineGenerations: { [MID.pid]: 2 },
      rememberedRoutes: [{ exeName: 'two-badges.exe', deviceIds: ['tv'] }],
      autoRemember: true,
    });

    await state().stopAllRoutes();
    await state().restoreRememberedRoutes();

    expect(backend.calls.filter((c) => c.cmd === 'apply_route')).toHaveLength(0);
    expect(state().routedPids).toEqual({});
    expect(state().engineGenerations).toEqual({});
    expect(
      backend.calls
        .filter((c) => c.cmd === 'stop_route')
        .map((c) => c.args.pid)
        .sort(),
    ).toEqual([MID.pid, HIGH.pid]);
  });

  it('does not report a batch as pinned when a sibling in it holds the device', async () => {
    // Every route in the batch is being stopped, so an assignment one stop hands
    // to a sibling of the same program is not left behind: the sibling's own
    // stop is the one that releases it — or says so in this same batch.
    const SIBLING: AudioSession = { pid: 1014, exe_name: 'music.exe' };
    installBackend({
      stopOutcomes: { [MUSIC.pid]: { released: false, pinned_device: 'tv', sibling_held: true } },
    });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC, SIBLING],
      routedPids: { [MUSIC.pid]: ['tv'], [SIBLING.pid]: ['tv'] },
    });

    await state().stopAllRoutes();

    expect(state().logs.filter((entry) => entry.level === 'error')).toHaveLength(0);
  });

  it('raises one card for the whole batch, however many stops refused', async () => {
    // One user action, one card: without the batch each refused stop replaced
    // the notice before it — the card flickered through the failures and only
    // the last one was left standing, which is the stack of complaints the
    // rule exists to prevent. The log still keeps every refusal.
    const FIRST: AudioSession = { pid: 9101, exe_name: 'batch-a.exe' };
    const SECOND: AudioSession = { pid: 9102, exe_name: 'batch-b.exe' };
    installBackend({
      sessions: [FIRST, SECOND],
      fail: (cmd) => cmd === 'stop_route',
    });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [FIRST, SECOND],
      routedPids: { [FIRST.pid]: ['tv'], [SECOND.pid]: ['speakers'] },
    });

    const noticeIds: number[] = [];
    const unwatch = useRouterStore.subscribe((s, previous) => {
      if (s.errorNotice !== null && s.errorNotice !== previous.errorNotice) {
        noticeIds.push(s.errorNotice.id);
      }
    });
    await state().stopAllRoutes();
    unwatch();

    expect(noticeIds).toHaveLength(1);
    // The two identical refusals are said once on the card…
    expect(state().errorNotice?.message).toBe(
      i18next.t('log.stopRouteFailed', { error: 'Error: stop_route failed' }),
    );
    // …but every one of them is on the record: two refusals plus the batch's
    // own error line.
    expect(state().logs.filter((entry) => entry.level === 'error')).toHaveLength(3);
  });
});

describe('primary volume', () => {
  it('leaves a newer number standing when an older click is refused', async () => {
    // The step buttons fire without waiting on the write, so two can be in the
    // air at once. Rolling the *older* rejection back over the newer value would
    // leave the UI naming a loudness the engines are not applying.
    installBackend({ fail: (cmd, args) => cmd === 'set_primary_volume' && args.percent === 60 });
    reset({ devices: [SPEAKERS], sessions: [MUSIC] });

    const older = state().setPrimaryVolume('music.exe', 60);
    await state().setPrimaryVolume('music.exe', 55);
    await older;

    expect(state().primaryVolumes['music.exe']).toBe(55);
  });

  it('restores the previous number when the only write is refused', async () => {
    installBackend({ fail: (cmd) => cmd === 'set_primary_volume' });
    reset({ devices: [SPEAKERS], sessions: [MUSIC], primaryVolumes: { 'music.exe': 80 } });

    await state().setPrimaryVolume('music.exe', 70);

    expect(state().primaryVolumes['music.exe']).toBe(80);
  });
});

describe("the tour's start clean", () => {
  it('takes down what the restore put up, then forgets the memory and tuning', async () => {
    const backend = installBackend({
      remembered: [['music.exe', ['tv']]],
      feeds: [['music.exe', 'game.exe']],
      delays: [['tv', 120]],
      volumes: [['tv', 80]],
    });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC, GAME],
      routedPids: { [MUSIC.pid]: ['tv'] },
      engineGenerations: { [MUSIC.pid]: 0 },
      rememberedRoutes: [{ exeName: 'music.exe', deviceIds: ['tv'] }],
      rememberedFeeds: [{ sourceExe: 'music.exe', targetExe: ['game.exe'] }],
      feeds: { [MUSIC.pid]: [GAME.pid] },
      deviceDelays: { tv: 120 },
      deviceVolumes: { tv: 80 },
      defaultDeviceId: 'speakers',
    });

    await state().startClean();

    // What the boot restore had put up is down again: the route stopped — its
    // assignment released by the stop, not left for the reset to find — and the
    // feed disconnected at both ends rather than only on screen.
    expect(state().routedPids).toEqual({});
    expect(state().feeds).toEqual({});
    const seen = backend.calls.map((c) => c.cmd);
    expect(seen).toContain('stop_route');
    expect(seen).toContain('remove_feed_target');

    // And the predecessor's memory and tuning are gone in one write, with the
    // boards reloaded from what is now an empty file.
    expect(seen).toContain('forget_previous_settings');
    expect(state().rememberedRoutes).toEqual([]);
    expect(state().rememberedFeeds).toEqual([]);
    expect(state().deviceDelays).toEqual({});
    expect(state().deviceVolumes).toEqual({});
    expect(backend.remembered).toEqual([]);
    expect(backend.delays).toEqual([]);
  });

  it('refuses out loud when the memory would not go', async () => {
    // The tour is the only place this wipe is offered, and it does not come
    // back for a second try — a half-done clean the user cannot see leaves them
    // on a machine they believe is empty.
    const backend = installBackend({
      remembered: [['music.exe', ['tv']]],
      fail: (cmd) => cmd === 'forget_previous_settings',
    });
    reset({ rememberedRoutes: [{ exeName: 'music.exe', deviceIds: ['tv'] }] });

    await expect(state().startClean()).rejects.toThrow();

    expect(lastLog()?.level).toBe('error');
    expect(backend.remembered).toEqual([['music.exe', ['tv']]]);
  });

  it('raises one card for the whole wipe and says every refusal together', async () => {
    // The wipe is one user action that can fail in several places at once — a
    // refused stop per route and a stuck wire per feed — and the tour demands
    // exactly one notice for it. Without the batch this raises three cards in a
    // row; with it the refusals ride one card, each still written to the log
    // the moment it happens, including when the wipe throws.
    const SOURCE: AudioSession = { pid: 9001, exe_name: 'wipe-a.exe' };
    const SECOND: AudioSession = { pid: 9002, exe_name: 'wipe-b.exe' };
    const LISTENER: AudioSession = { pid: 9003, exe_name: 'wipe-c.exe' };
    installBackend({
      sessions: [SOURCE, SECOND, LISTENER],
      fail: (cmd) => cmd === 'stop_route' || cmd === 'remove_feed_target',
    });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [SOURCE, SECOND, LISTENER],
      routedPids: { [SOURCE.pid]: ['tv'], [SECOND.pid]: ['speakers', 'tv'] },
      engineGenerations: { [SECOND.pid]: 1 },
      rememberedFeeds: [{ sourceExe: 'wipe-a.exe', targetExe: ['wipe-c.exe'] }],
      feeds: { [SOURCE.pid]: [LISTENER.pid] },
    });

    const noticeIds: number[] = [];
    const unwatch = useRouterStore.subscribe((s, previous) => {
      if (s.errorNotice !== null && s.errorNotice !== previous.errorNotice) {
        noticeIds.push(s.errorNotice.id);
      }
    });
    await state().startClean();
    unwatch();

    expect(noticeIds).toHaveLength(1);
    const stopMsg = i18next.t('log.stopRouteFailed', { error: 'Error: stop_route failed' });
    const feedMsg = i18next.t('log.feedRemoveFailed', {
      error: 'Error: remove_feed_target failed',
    });
    expect(state().errorNotice?.message).toBe([stopMsg, feedMsg].join(' · '));
    // Two refusals to stop, one refused wire, and the batch's own line — the
    // record keeps them all even though the card is one.
    expect(state().logs.filter((entry) => entry.level === 'error')).toHaveLength(4);
  });
});
