import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SourceLevelDial } from './SourceLevelDial';

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The dial is the hub's, and it leaves with the route: the plan coming down to
 * one device unmounts it, and if the caret sat inside the number it died with
 * the card — the next Tab then started again at the top of the window. AGENTS.md
 * asks a control that unmounts to hand the focus to its host, and this is the
 * whole mechanism: an element removed from the DOM leaves
 * `document.activeElement` as the body, which is how the dial knows the focus it
 * just lost was its own to give back.
 */

const { state } = vi.hoisted(() => ({
  state: {
    sourceVolumes: {} as Record<string, number>,
    setSourceVolume: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('@/stores/routerStore', () => ({
  useRouterStore: (selector: (s: typeof state) => unknown) => selector(state),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;
/** Stand-in for the hub card: one stable ref object, as `useRef` gives it. */
const hostRef: { current: HTMLElement | null } = { current: null };

/** The hub card and, while `withDial` holds, the dial mounted under it. */
function mount(withDial: boolean): void {
  act(() => {
    root?.render(
      <>
        <button type="button" ref={(el) => void (hostRef.current = el)}>
          hub
        </button>
        {withDial && <SourceLevelDial exeName="game.exe" displayName="Game" hostRef={hostRef} />}
      </>,
    );
  });
}

function dialOf(): HTMLElement {
  const dial = container?.querySelector<HTMLElement>('[role="slider"]');
  if (!dial) throw new Error('the dial renders its number as the control');
  return dial;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  mount(true);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  hostRef.current = null;
});

describe('SourceLevelDial leaving the board', () => {
  it('gives the focus back to the card it is mounted under', () => {
    const dial = dialOf();
    dial.focus();
    expect(document.activeElement).toBe(dial);

    mount(false);
    expect(document.activeElement).toBe(hostRef.current);
  });

  it('stays out of the way when the focus already went somewhere else', () => {
    const other = document.createElement('button');
    document.body.append(other);
    try {
      dialOf().focus();
      other.focus();
      mount(false);
      expect(document.activeElement).toBe(other);
    } finally {
      other.remove();
    }
  });
});
