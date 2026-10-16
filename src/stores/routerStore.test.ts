import { describe, expect, it, vi } from 'vitest';
import { mockIPC } from '@tauri-apps/api/mocks';
import type { AudioDevice, AudioSession, ResetOutcome, StopOutcome } from '@/lib/types';
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
    if (backend.fail(cmd, args)) throw new Error(`${cmd} failed`);

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
        if (deviceIds.length <= 1) {
          delete backend.routeGenerations[pid];
          return 0;
        }
        backend.generation += 1;
        backend.routeGenerations[pid] = backend.generation;
        return backend.generation;
      }
      case 'stop_route': {
        const pid = args.pid as number;
        delete backend.routes[pid];
        delete backend.routeGenerations[pid];
        return {
          released: true,
          pinned_device: null,
          sibling_held: false,
          ...backend.stopOutcomes[pid],
        };
      }
      case 'get_active_duplications':
        // The real command lists *engines*, so single-device routes — which
        // have none — never appear here. The real contract is a parallel array
        // matching deviceIds, and the primary (index 0) reports `null` —
        // Windows plays it itself, there is no stream of ours to measure. Same
        // shape the e2e bridge fakes.
        return Object.entries(backend.routes)
          .filter(([, deviceIds]) => deviceIds.length > 1)
          .map(([pid, deviceIds]) => ({
            pid: Number(pid),
            generation: backend.routeGenerations[Number(pid)] ?? 0,
            deviceIds,
            latencyMs: deviceIds.map((_, index) => (index === 0 ? null : 20)),
          }));
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
        const sourceExe = args.sourceExe as string;
        const targetExe = args.targetExe as string;
        if (!backend.feeds.some(([s2, t]) => s2 === sourceExe && t === targetExe)) {
          backend.feeds = [...backend.feeds, [sourceExe, targetExe]];
        }
        if (backend.carrier.render === null || backend.carrier.capture === null) {
          return { delivered: false, reason: 'no_carrier' };
        }
        return { delivered: true, reason: null };
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
      case 'clear_route':
        backend.remembered = backend.remembered.filter(([name]) => name !== args.exeName);
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
    deviceSelectionPrefilled: true,
    routedPids: {},
    engineGenerations: {},
    deviceLatencyMs: {},
    deviceDelays: {},
    delayStepMs: 10,
    deviceVolumes: {},
    sourceVolumes: {},
    soundingPids: {},
    rememberedRoutes: [],
    rememberedFeeds: [],
    feeds: {},
    feedCarrier: { render: null, capture: null },
    captureDevices: [],
    feedUndo: null,
    defaultDeviceId: null,
    startupNotice: null,
    undoSnapshot: null,
    logs: [],
    applying: false,
    error: null,
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
});

describe('session activity', () => {
  it('tracks the transitions the backend forwards', () => {
    installBackend();
    reset({ soundingPids: {} });

    state().handleSessionActivity({ pid: 1001, active: true });
    expect(state().soundingPids[1001]).toBe(true);

    state().handleSessionActivity({ pid: 1001, active: false });
    expect(state().soundingPids[1001]).toBeUndefined();
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
    const backend = installBackend({ devices: [TV] });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC],
      routedPids: { 1001: ['speakers'] },
      engineGenerations: { 1001: 0 },
    });

    await state().refreshDevices(true);

    expect(state().routedPids[1001]).toBeUndefined();
    const stopped = backend.calls.filter((c) => c.cmd === 'stop_route');
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.args.pid).toBe(1001);
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

  it('clamps a delay past the hard bound before storing it', async () => {
    installBackend();
    reset({ deviceDelays: {} });

    await state().setDeviceDelayValue('tv', 99_999);

    expect(state().deviceDelays.tv).toBe(10_000);
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
  it('connects a programme into another input and offers the way back', async () => {
    const backend = installBackend();
    reset({ devices: [SPEAKERS, TV], sessions: [MUSIC, GAME], feedCarrier: backend.carrier });

    await state().addFeed(MUSIC.pid, GAME.pid);

    expect(state().feeds[MUSIC.pid]).toEqual([GAME.pid]);
    expect(state().rememberedFeeds).toEqual([{ sourceExe: 'music.exe', targetExe: ['game.exe'] }]);
    // Connected at once: a feed pins its own endpoints, so no hub press waits
    // between the pick and the sound.
    expect(backend.calls.some((call) => call.cmd === 'set_feed_target')).toBe(true);
    expect(state().feedUndo).toMatchObject({ sourcePid: MUSIC.pid, targetPid: GAME.pid });

    await state().undoFeed();

    expect(state().feeds[MUSIC.pid]).toBeUndefined();
    expect(state().rememberedFeeds).toEqual([]);
    // The undo is the end of the chain, not a new offer.
    expect(state().feedUndo).toBeNull();
  });

  it('records a feed but says it is silent when no carrier is configured', async () => {
    installBackend({ carrier: { render: null, capture: null } });
    reset({ devices: [SPEAKERS, TV], sessions: [MUSIC, GAME] });

    await state().addFeed(MUSIC.pid, GAME.pid);

    // The rule is the user's decision and stays; nothing moves until a pair is
    // picked in the settings, and the log says exactly that.
    expect(state().feeds[MUSIC.pid]).toEqual([GAME.pid]);
    expect(state().rememberedFeeds).toHaveLength(1);
    expect(lastLog()?.message).toContain('no carrier');
    expect(lastLog()?.level).toBe('error');
  });

  it('rolls the whole rule back when the backend refuses it', async () => {
    installBackend({ fail: (cmd) => cmd === 'set_feed_target' });
    reset({ devices: [SPEAKERS, TV], sessions: [MUSIC, GAME] });

    await state().addFeed(MUSIC.pid, GAME.pid);

    expect(state().feeds[MUSIC.pid]).toBeUndefined();
    expect(state().rememberedFeeds).toEqual([]);
    expect(state().feedUndo).toBeNull();
    expect(lastLog()?.level).toBe('error');
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

  it('refuses to feed a programme into itself', async () => {
    installBackend();
    reset({ devices: [SPEAKERS, TV], sessions: [MUSIC, GAME] });

    await state().addFeed(MUSIC.pid, MUSIC.pid);

    expect(state().feeds[MUSIC.pid]).toBeUndefined();
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

  it('does not re-pin a feed the user added this run when a refresh comes by', async () => {
    const backend = installBackend();
    reset({ devices: [SPEAKERS, TV], sessions: [MUSIC, GAME], feedCarrier: backend.carrier });

    await state().addFeed(MUSIC.pid, GAME.pid);
    const asksAfterAdd = backend.calls.filter((c) => c.cmd === 'set_feed_target').length;

    // A Core Audio change arrives; the restore pass runs with it. The feed
    // was delivered when it was added, so the pass has nothing to do here.
    await state().refreshSessions();

    expect(backend.calls.filter((c) => c.cmd === 'set_feed_target')).toHaveLength(asksAfterAdd);
    expect(state().feeds[MUSIC.pid]).toEqual([GAME.pid]);
  });

  it('reads a sibling session’s route as holding the render slot', () => {
    // The per-app endpoint the audio service keeps is one per executable: a
    // route held by one process of the program occupies the slot for every
    // session of it, so a feed from a sibling is suspended, not live.
    const BROWSER_TAB: AudioSession = { pid: 6201, exe_name: 'browser.exe' };
    const BROWSER_HELPER: AudioSession = { pid: 6202, exe_name: 'browser.exe' };
    const OTHER: AudioSession = { pid: 6203, exe_name: 'other.exe' };
    const carrier = { render: 'cable-in', capture: 'cable-out' };

    expect(
      feedLiveness(BROWSER_HELPER.pid, carrier, { [BROWSER_TAB.pid]: ['speakers'] }, [
        BROWSER_TAB,
        BROWSER_HELPER,
        OTHER,
      ]),
    ).toBe('suspended');
    // A route of a different program holds nobody else's slot.
    expect(
      feedLiveness(BROWSER_HELPER.pid, carrier, { [OTHER.pid]: ['speakers'] }, [
        BROWSER_TAB,
        BROWSER_HELPER,
        OTHER,
      ]),
    ).toBe('live');
    // The program's own route still reads as suspended, as always.
    expect(
      feedLiveness(BROWSER_TAB.pid, carrier, { [BROWSER_TAB.pid]: ['speakers'] }, [
        BROWSER_TAB,
        BROWSER_HELPER,
      ]),
    ).toBe('suspended');
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
