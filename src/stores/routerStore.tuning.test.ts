import { describe, expect, it } from 'vitest';

import {
  SPEAKERS,
  TV,
  HEADPHONES,
  MUSIC,
  installBackend,
  lastLog,
  reset,
  state,
} from './router/harness';

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
