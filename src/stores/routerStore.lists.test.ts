import { describe, expect, it, vi } from 'vitest';

import type { AudioSession } from '@/lib/types';

import {
  SPEAKERS,
  TV,
  HEADPHONES,
  MUSIC,
  GAME,
  installBackend,
  lastLog,
  reset,
  state,
} from '@/test/routerHarness';

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
