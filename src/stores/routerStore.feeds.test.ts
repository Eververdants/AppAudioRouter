import { describe, expect, it } from 'vitest';

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

import { feedLiveness } from './routerStore';

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

  it('feeds a running app that has never made a sound, staged from the window pool', async () => {
    // A feed's receiving end is often an app with no render session at all —
    // an idle recorder, a game in its menu — and the capture pin it gets
    // covers sessions started after it. The pool, not the session list, is
    // what the plan and the live map resolve that half through.
    const IDLE_RECORDER: AudioSession = { pid: 7001, exe_name: 'idle-rec.exe' };
    const backend = installBackend();
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC, GAME],
      windowApps: [IDLE_RECORDER],
      feedCarrier: backend.carrier,
    });
    state().selectProcess(MUSIC.pid);
    state().appendFeedTarget(IDLE_RECORDER.pid);

    // Staged from the pool, and nothing has been asked of the backend yet.
    expect(state().selectedFeedPids).toEqual([IDLE_RECORDER.pid]);
    expect(backend.calls.some((c) => c.cmd === 'set_feed_target')).toBe(false);

    await state().applyRoute();

    expect(backend.calls.find((c) => c.cmd === 'set_feed_target')?.args).toMatchObject({
      sourcePid: MUSIC.pid,
      targetPid: IDLE_RECORDER.pid,
      targetExe: 'idle-rec.exe',
    });
    expect(state().feeds[MUSIC.pid]).toEqual([IDLE_RECORDER.pid]);

    // And the rule survives the refresh that rebuilds the map: the target is
    // on no session list, so the pool is what answers for it there too.
    await state().refreshSessions();
    expect(state().feeds[MUSIC.pid]).toEqual([IDLE_RECORDER.pid]);
    expect(state().errorNotice).toBeNull();
  });

  it('restores a remembered feed whose target runs silently', async () => {
    // The boot restore used to skip a target the session list did not hold,
    // which made a rule to a silent app un-restorable — pinned never again
    // after a restart even though the pin needs no session of its own.
    // Fresh names: the restore-decided set lives at module level, and the
    // pair an earlier test landed was claimed by that landing.
    const QUIET_SOURCE: AudioSession = { pid: 7100, exe_name: 'quiet-source.exe' };
    const IDLE_RECORDER: AudioSession = { pid: 7101, exe_name: 'idle-rec.exe' };
    const backend = installBackend({
      sessions: [MUSIC, GAME, QUIET_SOURCE],
      feeds: [['quiet-source.exe', 'idle-rec.exe']],
      windowApps: [IDLE_RECORDER],
    });
    reset({
      devices: [SPEAKERS, TV],
      sessions: [MUSIC, GAME, QUIET_SOURCE],
      feedCarrier: backend.carrier,
    });

    // The boot reads, in either landing order: the pool and the memory are the
    // two inputs the restore waits for, and whichever lands last asks.
    await state().loadWindowApps();
    await state().loadFeeds();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state().feeds[QUIET_SOURCE.pid]).toEqual([IDLE_RECORDER.pid]);
    expect(
      backend.calls.some(
        (c) => c.cmd === 'set_feed_target' && c.args.targetPid === IDLE_RECORDER.pid,
      ),
    ).toBe(true);
  });
});
