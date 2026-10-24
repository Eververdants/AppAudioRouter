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

import { useRouterStore } from './routerStore';

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
