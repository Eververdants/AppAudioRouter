/**
 * Shared test environment: the browser APIs jsdom does not implement, and a
 * clean slate for every test.
 *
 * This is the "mock runtime" floor the unit tests stand on — no network, no
 * filesystem access outside the repository, no real Tauri shell. Tests that
 * need the backend install their own handler with `mockIPC`; this file only
 * makes sure an un-mocked call fails loudly instead of hanging.
 */

import { afterEach, beforeEach, vi } from 'vitest';
import { clearMocks } from '@tauri-apps/api/mocks';

/** jsdom has no media query engine; the theme and motion hooks read one. */
function stubMatchMedia(): void {
  if (typeof window.matchMedia === 'function') return;
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

/** jsdom has no layout engine, so anything observing element sizes needs this. */
function stubResizeObserver(): void {
  if (typeof globalThis.ResizeObserver === 'function') return;
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

/** jsdom ships no idle callback; `App` falls back to a timeout, tests use this. */
function stubIdleCallbacks(): void {
  const w = window as unknown as Record<string, unknown>;
  if (typeof w.requestIdleCallback !== 'function') {
    w.requestIdleCallback = (cb: (info: { didTimeout: boolean }) => void) =>
      window.setTimeout(() => cb({ didTimeout: false }), 0) as unknown as number;
    w.cancelIdleCallback = (handle: number) => window.clearTimeout(handle);
  }
}

stubMatchMedia();
stubResizeObserver();
stubIdleCallbacks();

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  // Drop the fake IPC so a test that forgets its own setup cannot silently
  // inherit the previous one's backend.
  clearMocks();
  vi.restoreAllMocks();
});
