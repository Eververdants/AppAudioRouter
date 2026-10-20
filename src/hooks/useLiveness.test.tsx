import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { useLiveness } from './useLiveness';

/**
 * The gate over the interface's only standing repaints (the flowing wire and
 * the pulsing ring). AGENTS.md makes it a hard constraint — hidden, blurred or
 * reduced-motion must take the loops *off*, not pause them — and the answer is
 * read from three browser APIs, so what is worth pinning is that every one of
 * the three really turns it off, that it keeps following the window while it
 * is mounted, and that a host which cannot answer is read as "still" instead of
 * throwing during the board's first render.
 */

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** Every value the probe rendered with, oldest first. */
const seen: boolean[] = [];

function Probe() {
  seen.push(useLiveness());
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(): boolean {
  seen.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  const node = container;
  act(() => {
    root = createRoot(node);
    root?.render(<Probe />);
  });
  return seen[seen.length - 1] ?? true;
}

function unmount() {
  const mounted = root;
  const node = container;
  act(() => {
    mounted?.unmount();
  });
  node?.remove();
  root = null;
  container = null;
}

/** The three reads the gate makes, set at once. */
function environment(input: {
  visible?: boolean;
  focused?: boolean;
  reduced?: boolean;
  hasFocusApi?: boolean;
  matchMediaApi?: boolean;
}): void {
  const { visible = true, focused = true, reduced = false } = input;
  const hasFocus = input.hasFocusApi === false ? undefined : () => focused;
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: hasFocus });
  const matchMedia =
    input.matchMediaApi === false
      ? undefined
      : (query: string) =>
          ({
            matches: query.includes('prefers-reduced-motion') ? reduced : false,
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
          }) as unknown as MediaQueryList;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: matchMedia,
  });
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (visible ? 'visible' : 'hidden'),
  });
}

afterEach(() => {
  unmount();
  Reflect.deleteProperty(document, 'hasFocus');
  Reflect.deleteProperty(window, 'matchMedia');
  Reflect.deleteProperty(document, 'visibilityState');
});

describe('useLiveness', () => {
  it('flows while the window is visible, focused, and motion is ordinary', () => {
    environment({});
    expect(mount()).toBe(true);
  });

  it('unmounts the loops for a hidden window, an unfocused one, or reduced motion', () => {
    for (const input of [{ visible: false }, { focused: false }, { reduced: true }]) {
      environment(input);
      expect(mount()).toBe(false);
      unmount();
    }
  });

  it('follows the window out of view while it is mounted', () => {
    environment({});
    expect(mount()).toBe(true);

    // Hide it: the gate goes false, so the callers drop the animation rather
    // than holding it paused.
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    seen.length = 0;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(seen[seen.length - 1]).toBe(false);
  });

  it('goes still instead of throwing when the focus and motion APIs are missing', () => {
    // The regression this pins: both reads were taken as certain to exist, and
    // they happen in the first render of the board — a TypeError there is the
    // whole routing screen going white, not a missing animation.
    environment({ hasFocusApi: false, matchMediaApi: false });
    expect(mount()).toBe(false);
  });

  it('stops listening when the component is gone', () => {
    environment({});
    mount();
    unmount();
    seen.length = 0;
    expect(() => {
      act(() => {
        window.dispatchEvent(new Event('blur'));
      });
    }).not.toThrow();
    expect(seen).toEqual([]);
  });
});
