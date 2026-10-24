import { describe, expect, it } from 'vitest';

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
