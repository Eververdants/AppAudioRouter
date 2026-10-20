import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { mockIPC } from '@tauri-apps/api/mocks';
import * as api from './invoke';

/**
 * The command layer is the whole contract between the frontend and Rust, so
 * these tests assert the one thing a typo here would break silently: that each
 * wrapper asks for the command the backend actually registered, with arguments
 * under the names `commands.rs` reads. The backend itself is replaced by
 * `mockIPC`, so the run never touches Core Audio.
 */
describe('invoke wrappers', () => {
  it('asks for the enumerations by their registered names', async () => {
    const seen: string[] = [];
    mockIPC((cmd) => {
      seen.push(cmd);
      return cmd === 'list_devices' || cmd === 'list_sessions'
        ? []
        : { id: 'dev-1', name: 'Speakers' };
    });

    await api.listDevices();
    await api.listSessions();
    await api.getDefaultDevice();

    expect(seen).toEqual(['list_devices', 'list_sessions', 'get_default_device']);
  });

  it('opens a page by its key, because the URL never comes from here', async () => {
    const seen: [string, Record<string, unknown>][] = [];
    mockIPC((cmd, args) => {
      seen.push([cmd, args as Record<string, unknown>]);
      return null;
    });

    await api.openCarrierDownload('voicemeeter');
    await api.openHelpPage('readme-zh');

    expect(seen).toEqual([
      ['open_carrier_download', { key: 'voicemeeter' }],
      ['open_help_page', { key: 'readme-zh' }],
    ]);
  });

  it('passes the route as an ordered device list with the remember flag', async () => {
    let payload: Record<string, unknown> | undefined;
    mockIPC((cmd, args) => {
      if (cmd === 'apply_route') payload = args as Record<string, unknown>;
      return 1;
    });

    const generation = await api.applyRoute(4242, 'music.exe', ['speakers', 'tv'], true);

    expect(generation).toBe(1);
    expect(payload).toEqual({
      pid: 4242,
      exeName: 'music.exe',
      deviceIds: ['speakers', 'tv'],
      remember: true,
    });
  });

  it('sends the delay and volume edits with their values', async () => {
    const seen: [string, Record<string, unknown>][] = [];
    mockIPC((cmd, args) => {
      seen.push([cmd, (args ?? {}) as Record<string, unknown>]);
      return null;
    });

    await api.setDeviceDelay('tv', -250);
    await api.setDeviceVolume('tv', 80);
    await api.setSourceVolume('music.exe', 150);
    await api.clearRoute('music.exe');

    expect(seen).toEqual([
      ['set_device_delay', { deviceId: 'tv', delayMs: -250 }],
      ['set_device_volume', { deviceId: 'tv', percent: 80 }],
      ['set_source_volume', { exeName: 'music.exe', percent: 150 }],
      ['clear_route', { exeName: 'music.exe' }],
    ]);
  });

  it('asks for the calibration tone by its registered name', async () => {
    const seen: string[] = [];
    mockIPC((cmd) => {
      seen.push(cmd);
      return null;
    });

    await api.calibrationStart('speakers');
    await api.calibrationCancel();

    expect(seen).toEqual(['calibration_start', 'calibration_cancel']);
  });

  it('returns the values the backend answered with', async () => {
    mockIPC((cmd) => {
      switch (cmd) {
        case 'get_device_delays':
          return [['tv', -250]];
        case 'get_device_volumes':
          return [['tv', 80]];
        case 'get_source_volumes':
          return [['music.exe', 150]];
        case 'get_remembered_routes':
          return [['music.exe', ['tv']]];
        case 'get_startup_notice':
          return { kind: 'upgrade', previous_version: '2.0.0' };
        case 'stop_route':
          return { released: true, pinned_device: null, sibling_held: false };
        case 'reset_pinned_endpoints':
          return { released: 3, still_pinned: ['game.exe'], still_pinned_devices: ['tv'] };
        case 'release_stale_routes':
          return ['old.exe'];
        case 'is_silent_launch':
          return false;
        default:
          return null;
      }
    });

    await expect(api.getDeviceDelays()).resolves.toEqual([['tv', -250]]);
    await expect(api.getDeviceVolumes()).resolves.toEqual([['tv', 80]]);
    await expect(api.getSourceVolumes()).resolves.toEqual([['music.exe', 150]]);
    await expect(api.getRememberedRoutes()).resolves.toEqual([['music.exe', ['tv']]]);
    await expect(api.getStartupNotice()).resolves.toEqual({
      kind: 'upgrade',
      previous_version: '2.0.0',
    });
    await expect(api.stopRoute(1)).resolves.toEqual({
      released: true,
      pinned_device: null,
      sibling_held: false,
    });
    await expect(api.resetPinnedEndpoints()).resolves.toEqual({
      released: 3,
      still_pinned: ['game.exe'],
      still_pinned_devices: ['tv'],
    });
    await expect(api.releaseStaleRoutes()).resolves.toEqual(['old.exe']);
    await expect(api.isSilentLaunch()).resolves.toBe(false);
  });

  it('rejects with the backend error so callers can roll back', async () => {
    mockIPC(() => {
      throw new Error('device not found');
    });

    await expect(api.applyRoute(1, 'music.exe', ['gone'], true)).rejects.toThrow(
      'device not found',
    );
    await expect(api.stopRoute(1)).rejects.toThrow('device not found');
  });

  it('hands on a rejection that is a bare string, because Rust answers Err(String)', async () => {
    // The shape the product actually produces: every command in `commands.rs`
    // is `Result<T, String>`, and Tauri rejects with the serialized Err value —
    // a string, not an `Error`. `invoke` does not wrap it, so the only way a
    // caller can report "device not found" is to stringify what it got; reading
    // `.message` off it would be `undefined`, and the wrapper must not pretend
    // otherwise by laundering the value into an Error of its own.
    mockIPC(() => {
      throw 'device not found';
    });

    await expect(api.applyRoute(1, 'music.exe', ['gone'], true)).rejects.toBe('device not found');
    await expect(api.setDeviceDelay('tv', 5)).rejects.toBe('device not found');
    // ...and a caller that formats it does get the sentence back.
    const reported = await api
      .applyRoute(1, 'music.exe', ['gone'], true)
      .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(reported).toBe('device not found');
  });

  it('resolves the fire-and-forget commands without a value', async () => {
    const seen: string[] = [];
    mockIPC((cmd) => {
      seen.push(cmd);
      return null;
    });

    await expect(
      api.setTrayLabels({
        show: 'Show',
        openSettings: 'Settings',
        autostart: 'Start',
        autostartChecked: true,
        stopAll: 'Stop all',
        quit: 'Quit',
      }),
    ).resolves.toBeUndefined();
    await expect(api.ackStartupNotice()).resolves.toBeUndefined();
    await expect(api.setAutostart(true)).resolves.toBeUndefined();
    await expect(api.setCloseToTray(false)).resolves.toBeUndefined();
    await expect(api.alignSourceLevels()).resolves.toEqual(null);

    expect(seen).toEqual([
      'set_tray_labels',
      'ack_startup_notice',
      'set_autostart',
      'set_close_to_tray',
      'align_source_levels',
    ]);
  });

  it('asks for nothing the backend has not registered', () => {
    // The half of the wire contract `mockIPC` cannot see: the mock answers *any*
    // name, so a command renamed or deleted in `commands.rs` passes every test
    // above and fails only in the user's face. And `tsc` cannot see it either —
    // a command name is a string, not a type. So read the Rust file and require
    // every name this module asks for to be a registered command.
    //
    // The other direction — a registered command nobody asks for — is a dead
    // command rather than a crash, and is reported by review, not pinned here:
    // the list moves while the backend is being cleaned.
    const root = process.cwd().replace(/\\/g, '/');
    const rust = readFileSync(`${root}/src-tauri/src/commands.rs`, 'utf8');
    const registered = new Set(
      [
        ...rust.matchAll(/#\[tauri::command\][\s\S]{0,220}?pub\s+(?:async\s+)?fn\s+([a-z_0-9]+)/g),
      ].map((found) => found[1] as string),
    );
    expect(registered.size).toBeGreaterThan(30);

    const asked = commandsAskedFor();
    expect(asked.length).toBeGreaterThan(30);
    // Nothing asked for that the backend does not answer.
    expect(asked.filter((name) => !registered.has(name))).toEqual([]);
    // And no command is asked for twice under two wrappers — a duplicate would
    // hide a rename of the other one.
    expect(new Set(asked).size).toBe(asked.length);
  });
});

/** Every command name `invoke.ts` asks the backend for, in source order. */
function commandsAskedFor(): string[] {
  const source = readFileSync(`${process.cwd().replace(/\\/g, '/')}/src/lib/invoke.ts`, 'utf8');
  return [...source.matchAll(/invoke(?:<[^>]*>)?\(\s*'([a-z_0-9]+)'/g)].map(
    (found) => found[1] as string,
  );
}
