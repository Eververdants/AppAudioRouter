import { describe, expect, it } from 'vitest';

import type { AudioSession } from '@/lib/types';

import { SPEAKERS, TV, MUSIC, GAME, installBackend, lastLog, reset, state } from './router/harness';

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
