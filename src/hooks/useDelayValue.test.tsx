import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The delay draft, and the two promises `useDelayValue` makes about it.
 *
 * A draft is an edit of *one* device's number, so the hook has to hold it
 * against the device it was typed for: `deviceId` is a prop, and a control that
 * stops being keyed by it — or a device removed from the list above this one —
 * must not end up writing device A's typed figure onto device B. And a number
 * the user can see must not be lost because the field went away: an unmount
 * commits it, the way a blur does, with Escape as the only way out.
 *
 * The store is mocked rather than imported: this hook's job is the draft, and
 * what the backend does with the value belongs to the store's own tests.
 */
const { store } = vi.hoisted(() => {
  const setDeviceDelayValue = vi.fn((_deviceId: string, _delayMs: number) => Promise.resolve(true));
  return {
    store: {
      deviceDelays: {} as Record<string, number>,
      delayStepMs: 10,
      setDeviceDelayValue,
    },
  };
});

vi.mock('@/stores/routerStore', () => ({
  useRouterStore: (selector: (state: typeof store) => unknown) => selector(store),
}));

import { useDelayValue } from './useDelayValue';

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** Everything the hook hands a control, from the render that is on screen. */
interface View {
  committed: number;
  draft: string | null;
  setDraft: (text: string | null) => void;
  commit: () => void;
  nudge: (direction: 1 | -1, times?: number) => void;
  cancel: () => void;
  stepLabel: string;
  atMin: boolean;
  atMax: boolean;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let current: View | null = null;

function Field({ deviceId }: { deviceId: string }) {
  current = useDelayValue(deviceId) as View;
  return null;
}

/**
 * Render (or re-render) the one mounted field and hand back what it now sees.
 *
 * Always take the answer from here rather than holding on to a returned view:
 * the handlers close over the draft of the render they came from, so a stale
 * `commit()` would test the hook's closure instead of its state — the exact
 * thing a blur after typing is not.
 */
function render(deviceId: string): View {
  container ??= document.createElement('div');
  document.body.appendChild(container);
  const node = container;
  act(() => {
    if (root === null) root = createRoot(node);
    root.render(<Field deviceId={deviceId} />);
  });
  const view = current;
  if (view === null) throw new Error('the probe never rendered');
  return view;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  current = null;
  store.deviceDelays = {};
  store.delayStepMs = 10;
  store.setDeviceDelayValue.mockClear();
});

/** Every value the hook asked the store to write. */
function writes(): [string, number][] {
  return store.setDeviceDelayValue.mock.calls.map(
    ([deviceId, delayMs]) => [deviceId, delayMs] as [string, number],
  );
}

/**
 * Take the field's current handlers *outside* `act`, then run one of them
 * inside it: asking for a render from within an active `act` defers it to the
 * outer flush, and the handlers would then come from a stale render.
 */
function withView(deviceId: string, run: (view: View) => void): void {
  const view = render(deviceId);
  act(() => run(view));
}

describe('useDelayValue', () => {
  it('commits a typed draft to the device it was typed for', () => {
    store.deviceDelays = { a: 0 };
    withView('a', (view) => view.setDraft('-250'));
    expect(render('a').draft).toBe('-250');
    withView('a', (view) => view.commit());
    expect(writes()).toEqual([['a', -250]]);
  });

  it('does not show a draft that belongs to another device', () => {
    store.deviceDelays = { a: 0, b: 40 };
    withView('a', (view) => view.setDraft('120'));
    // The control stayed mounted and the device under it changed: the field now
    // reads the device it names, not the number typed for the other one.
    const swapped = render('b');
    expect(swapped.draft).toBeNull();
    expect(swapped.committed).toBe(40);
  });

  it('writes an abandoned draft to its own device, never to the one now on screen', () => {
    // The regression the hook owns: a draft held in state that outlives a change
    // of `deviceId` used to be committed through the *current* device, so a
    // removed device above the row moved one program's delay onto another.
    store.deviceDelays = { a: 0, b: 0 };
    withView('a', (view) => view.setDraft('500'));
    withView('b', (view) => view.commit());
    expect(writes()).toEqual([['a', 500]]);
  });

  it('flushes a visible draft when the field unmounts', () => {
    store.deviceDelays = { a: 0 };
    withView('a', (view) => view.setDraft('300'));
    act(() => root?.unmount());
    root = null;
    expect(writes()).toEqual([['a', 300]]);
  });

  it('keeps Escape as the only way to drop an edit, even on unmount', () => {
    store.deviceDelays = { a: 0 };
    withView('a', (view) => view.setDraft('300'));
    withView('a', (view) => {
      view.cancel();
      view.commit();
    });
    expect(writes()).toEqual([]);
    // Nothing left to flush: the blur consumed the abandonment.
    act(() => root?.unmount());
    root = null;
    expect(writes()).toEqual([]);
  });

  it('drops a value that is not a number instead of writing zero', () => {
    store.deviceDelays = { a: 10 };
    for (const text of ['', '   ', 'abc', '1e999']) {
      withView('a', (view) => view.setDraft(text));
      withView('a', (view) => view.commit());
    }
    expect(writes()).toEqual([]);
  });

  it('clamps a committed draft into the engine bounds', () => {
    store.deviceDelays = { a: 0 };
    withView('a', (view) => view.setDraft('999999'));
    withView('a', (view) => view.commit());
    expect(writes()).toEqual([['a', 10_000]]);
  });

  it('steps from the number on screen, and from the store when there is none', () => {
    store.deviceDelays = { a: 100 };
    withView('a', (view) => view.nudge(1, 2));
    expect(writes()).toEqual([['a', 120]]);

    store.setDeviceDelayValue.mockClear();
    withView('a', (view) => view.setDraft('45'));
    withView('a', (view) => view.nudge(-1));
    expect(writes()).toEqual([['a', 40]]);
  });

  it('writes a leftover draft of its own before stepping another device', () => {
    store.deviceDelays = { a: 0, b: 0 };
    withView('a', (view) => view.setDraft('70'));
    withView('b', (view) => view.nudge(1));
    expect(writes()).toEqual([
      ['a', 70],
      ['b', 10],
    ]);
  });

  it('reports the bounds from the committed value', () => {
    store.deviceDelays = { a: 10_000 };
    expect(render('a').atMax).toBe(true);
    store.deviceDelays = { a: -10_000 };
    expect(render('a').atMin).toBe(true);
  });
});
