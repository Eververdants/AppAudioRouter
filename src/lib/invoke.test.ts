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

  it('sends the delay, volume and range edits with their values', async () => {
    const seen: [string, Record<string, unknown>][] = [];
    mockIPC((cmd, args) => {
      seen.push([cmd, (args ?? {}) as Record<string, unknown>]);
      return null;
    });

    await api.setDeviceDelay('tv', -250);
    await api.setDelayRange(2000);
    await api.setDeviceVolume('tv', 80);
    await api.setSourceVolume('music.exe', 150);
    await api.clearRoute('music.exe');

    expect(seen).toEqual([
      ['set_device_delay', { deviceId: 'tv', delayMs: -250 }],
      ['set_delay_range', { rangeMs: 2000 }],
      ['set_device_volume', { deviceId: 'tv', percent: 80 }],
      ['set_source_volume', { exeName: 'music.exe', percent: 150 }],
      ['clear_route', { exeName: 'music.exe' }],
    ]);
  });

  it('returns the values the backend answered with', async () => {
    mockIPC((cmd) => {
      switch (cmd) {
        case 'get_device_delays':
          return [['tv', -250]];
        case 'get_delay_range':
          return 5000;
        case 'get_device_volumes':
          return [['tv', 80]];
        case 'get_source_volumes':
          return [['music.exe', 150]];
        case 'get_remembered_routes':
          return [['music.exe', ['tv']]];
        case 'get_startup_notice':
          return { kind: 'upgrade', previous_version: '2.0.0' };
        case 'stop_route':
          return { released: true, pinned_device: null };
        case 'reset_pinned_endpoints':
          return { released: 3, still_pinned: ['game.exe'] };
        case 'release_stale_routes':
          return ['old.exe'];
        case 'is_silent_launch':
          return false;
        default:
          return null;
      }
    });

    await expect(api.getDeviceDelays()).resolves.toEqual([['tv', -250]]);
    await expect(api.getDelayRange()).resolves.toBe(5000);
    await expect(api.getDeviceVolumes()).resolves.toEqual([['tv', 80]]);
    await expect(api.getSourceVolumes()).resolves.toEqual([['music.exe', 150]]);
    await expect(api.getRememberedRoutes()).resolves.toEqual([['music.exe', ['tv']]]);
    await expect(api.getStartupNotice()).resolves.toEqual({
      kind: 'upgrade',
      previous_version: '2.0.0',
    });
    await expect(api.stopRoute(1)).resolves.toEqual({ released: true, pinned_device: null });
    await expect(api.resetPinnedEndpoints()).resolves.toEqual({
      released: 3,
      still_pinned: ['game.exe'],
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

  it('resolves the fire-and-forget commands without a value', async () => {
    const seen: string[] = [];
    mockIPC((cmd) => {
      seen.push(cmd);
      return null;
    });

    await expect(api.setTrayLabels('Show', 'Quit')).resolves.toBeUndefined();
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
});
