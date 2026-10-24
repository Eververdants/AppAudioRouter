import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioDevice, AudioSession } from '@/lib/types';
import { useRouterStore } from '@/stores/routerStore';
import { NodeStage } from './NodeStage';

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  // The store's i18n module plugs this into i18next on import; the labels
  // themselves are echoed by `t` above, so the plugin only has to exist.
  initReactI18next: { type: '3rd-party', init: () => undefined },
}));

/**
 * The hub's programme swap. The card remounts on every programme switch
 * (`key={session.pid}`) while the swap states live one level up, so a switch
 * that changes no words — a sibling process of the same executable — must not
 * let the last real swap's ghost replay on the fresh card: the previous
 * programme's name and icon would flash back for a beat before the (unchanged)
 * answer settled.
 */

const SPEAKERS: AudioDevice = { id: 'speakers', name: 'Speakers' };
const MUSIC: AudioSession = { pid: 1001, exe_name: 'music.exe' };
const GAME: AudioSession = { pid: 1002, exe_name: 'game.exe' };
const GAME_SIBLING: AudioSession = { pid: 1003, exe_name: 'game.exe' };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function prime(sessions: AudioSession[]): void {
  useRouterStore.setState({
    devices: [SPEAKERS],
    sessions,
    defaultDeviceId: null,
    routedPids: {},
    engineGenerations: {},
    feeds: {},
    feedCarrier: { render: null, capture: null },
    feedTapFailures: {},
    rememberedFeeds: [],
    soundingPids: {},
    soundingExes: {},
    iconByExe: {},
    selectedPids: [],
    selectedDeviceIds: [],
    deviceSelectionPrefilled: false,
    selectedFeedPids: [],
    feedSelectionPrefilled: false,
  });
}

function mountBoard(): void {
  act(() => {
    root?.render(<NodeStage />);
  });
}

/** Selecting a programme the way the rail does: the store moves, the board
 *  follows. The device plan is cleared with the selection — no route is being
 *  staged here, the hub is the only thing under test. */
function select(pid: number): void {
  act(() => {
    useRouterStore.setState({
      selectedPids: [pid],
      selectedDeviceIds: [],
      deviceSelectionPrefilled: true,
    });
  });
}

/** The hub card's whole text, ghost characters included: the ghosts are spans
 *  in the same subtree, and a stale one is exactly what this file is hunting. */
function hubText(): string {
  return container?.querySelector('[data-source-node]')?.textContent ?? '';
}

describe('NodeStage', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = null;
    container = null;
  });

  it('does not replay the previous programme when a sibling takes the stage', () => {
    prime([MUSIC, GAME, GAME_SIBLING]);
    mountBoard();

    select(MUSIC.pid);
    expect(hubText()).toContain('music.exe');

    // A real swap: the game's name arrives and the music programme's name
    // rides the card as its departing ghost — this is the swap speaking, and
    // it is what the last assertion protects from replaying.
    select(GAME.pid);
    expect(hubText()).toContain('game.exe');
    expect(hubText()).toContain('music.exe');

    // A sibling of the same executable: same words, same tile, another pid.
    // The card remounts for it, and nothing on it may name the music
    // programme — not its own name, not the ghost of the swap two selections
    // ago, which is the flash the board used to show here.
    select(GAME_SIBLING.pid);
    expect(hubText()).toContain('game.exe');
    expect(hubText()).not.toContain('music.exe');
  });
});
