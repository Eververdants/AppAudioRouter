import { describe, expect, it } from 'vitest';

import type { AudioSession } from '@/lib/types';

import {
  SPEAKERS,
  TV,
  MUSIC,
  GAME,
  FRESH_MUSIC,
  installBackend,
  reset,
  state,
} from '@/test/routerHarness';

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
