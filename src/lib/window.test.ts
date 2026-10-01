import { describe, expect, it, vi } from 'vitest';
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import {
  closeWindow,
  isTauri,
  isWindowMaximized,
  minimizeWindow,
  onWindowResized,
  revealMainWindow,
  toggleMaximizeWindow,
} from './window';

/**
 * These tests cover the two states the window helpers exist for: inside the
 * Tauri shell, where they drive the native window, and outside it (a plain
 * browser tab during `vite dev`), where every one of them must do nothing
 * rather than throw.
 */

describe('outside the Tauri shell', () => {
  it('reports that it is not running inside Tauri', () => {
    expect(isTauri()).toBe(false);
  });

  it('resolves every window action to nothing', async () => {
    await expect(minimizeWindow()).resolves.toBeUndefined();
    await expect(toggleMaximizeWindow()).resolves.toBeUndefined();
    await expect(closeWindow()).resolves.toBeUndefined();
    await expect(revealMainWindow()).resolves.toBeUndefined();
  });

  it('reports the window as not maximized', async () => {
    await expect(isWindowMaximized()).resolves.toBe(false);
  });

  it('returns a no-op unsubscribe for the resize subscription', async () => {
    const off = await onWindowResized(() => {});
    expect(() => off()).not.toThrow();
  });
});

describe('inside the Tauri shell', () => {
  /** Installs the fake IPC and returns the commands that were called. */
  function withBackend(handler: (cmd: string) => unknown) {
    const calls: string[] = [];
    mockWindows('main');
    mockIPC((cmd) => {
      calls.push(cmd);
      return handler(cmd);
    });
    return calls;
  }

  it('reports that it is running inside Tauri', () => {
    withBackend(() => null);
    expect(isTauri()).toBe(true);
  });

  it('reveals a hidden window and hands it the focus', async () => {
    const calls = withBackend((cmd) => (cmd === 'plugin:window|is_visible' ? false : null));
    await revealMainWindow();
    expect(calls).toContain('plugin:window|is_visible');
    expect(calls).toContain('plugin:window|show');
  });

  it('leaves a window that is already visible alone', async () => {
    const calls = withBackend((cmd) => (cmd === 'plugin:window|is_visible' ? true : null));
    await revealMainWindow();
    expect(calls).not.toContain('plugin:window|show');
  });

  it('reports the maximized state the backend reports', async () => {
    withBackend((cmd) => (cmd === 'plugin:window|is_maximized' ? true : null));
    await expect(isWindowMaximized()).resolves.toBe(true);
  });

  it('swallows a failing window call instead of breaking the UI', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    withBackend(() => {
      throw new Error('permission denied');
    });
    // A missing ACL permission is the realistic case: the button must simply
    // do nothing, not take the window down with it.
    await expect(minimizeWindow()).resolves.toBeUndefined();
    await expect(isWindowMaximized()).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('never throws from the window actions even with no backend at all', async () => {
    clearMocks();
    // `__TAURI_INTERNALS__` still exists (so `isTauri()` is true) but its
    // `invoke` was removed: the lazy module load itself is what fails here.
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    await expect(toggleMaximizeWindow()).resolves.toBeUndefined();
  });
});
