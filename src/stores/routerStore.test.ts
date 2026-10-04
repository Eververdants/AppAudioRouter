import { describe, expect, it } from 'vitest';
import { mockIPC } from '@tauri-apps/api/mocks';
import type { AudioDevice, AudioSession } from '@/lib/types';
import { useRouterStore } from './routerStore';

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
  remembered: [string, string[]][];
  delays: [string, number][];
  volumes: [string, number][];
  calls: { cmd: string; args: Record<string, unknown> }[];
  generation: number;
  /** Return true to make a command fail, the way a real backend would. */
  fail: (cmd: string, args: Record<string, unknown>) => boolean;
}

function installBackend(overrides: Partial<Backend> = {}): Backend {
  const backend: Backend = {
    devices: [SPEAKERS, TV],
    sessions: [MUSIC, GAME],
    defaultDeviceId: 'speakers',
    routes: {},
    remembered: [],
    delays: [],
    volumes: [],
    calls: [],
    generation: 0,
    fail: () => false,
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
        backend.routes[pid] = [...(args.deviceIds as string[])];
        backend.generation += 1;
        return backend.generation;
      }
      case 'stop_route':
        delete backend.routes[args.pid as number];
        return { released: true, pinned_device: null };
      case 'get_active_duplications':
        return Object.entries(backend.routes).map(([pid, deviceIds]) => ({
          pid: Number(pid),
          generation: 1,
          deviceIds,
          latencyMs: deviceIds.map(() => 20),
        }));
      case 'get_remembered_routes':
        return backend.remembered;
      case 'clear_route':
        backend.remembered = backend.remembered.filter(([name]) => name !== args.exeName);
        return null;
      case 'get_device_delays':
        return backend.delays;
      case 'set_device_delay':
        return null;
      case 'get_delay_range':
        return 5000;
      case 'get_device_volumes':
        return backend.volumes;
      case 'set_device_volume':
        return null;
      case 'get_source_volumes':
        return [];
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
    delayRangeMs: 5000,
    delayStepMs: 10,
    deviceVolumes: {},
    sourceVolumes: {},
    soundingPids: {},
    rememberedRoutes: [],
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
  it('routes in delay order, remembers it, and offers the way back', async () => {
    const backend = installBackend();
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC],
      selectedPids: [1001],
      selectedDeviceIds: ['speakers', 'tv'],
      // The TV is 30 ms early, so it becomes the device the OS plays natively.
      deviceDelays: { tv: -30 },
      autoRemember: true,
    });

    await state().applyRoute();

    const apply = backend.calls.find((call) => call.cmd === 'apply_route');
    expect(apply?.args).toMatchObject({
      pid: 1001,
      exeName: 'music.exe',
      deviceIds: ['tv', 'speakers'],
      remember: true,
    });
    expect(state().routedPids[1001]).toEqual(['tv', 'speakers']);
    expect(state().engineGenerations[1001]).toBe(1);
    expect(state().rememberedRoutes).toEqual([
      { exeName: 'music.exe', deviceIds: ['tv', 'speakers'] },
    ]);
    expect(state().undoSnapshot).toMatchObject({
      remembered: true,
      deviceName: 'TV',
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
});

describe('engine events', () => {
  it('clears the route when the engine reports an error for the live generation', () => {
    installBackend();
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

  it('ends the route when the device that failed is the one the OS plays', () => {
    // The backend reports a mirror and never the primary, so this is the store
    // and the engine disagreeing about the route. Dropping the primary would
    // promote the copy into its place: drawn as the device Windows plays,
    // driven as a duplicate of a stream that is no longer being produced.
    installBackend();
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

  it('clamps stored delays when the range is narrowed', async () => {
    installBackend();
    reset({ deviceDelays: { tv: 4000, speakers: -4000 }, delayRangeMs: 5000 });

    await state().setDelayRange(2000);

    expect(state().delayRangeMs).toBe(2000);
    expect(state().deviceDelays.tv).toBe(2000);
    expect(state().deviceDelays.speakers).toBe(-2000);
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
