import { describe, expect, it } from 'vitest';
import i18next from 'i18next';

import type { AudioSession } from '@/lib/types';

import {
  SPEAKERS,
  TV,
  MUSIC,
  GAME,
  installBackend,
  lastLog,
  reset,
  state,
} from '@/test/routerHarness';

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
