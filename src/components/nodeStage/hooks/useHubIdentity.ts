import { useRef, useState } from 'react';
import { clampHubName } from '../shared';
import type { AudioSession } from '@/lib/types';
import { useRouterStore } from '@/stores/routerStore';

/** The hub's name slot mid-swap: the words arriving, the words departing, and
 *  the key that makes a re-selection cut the previous ghost instead of queueing
 *  it. `key === 0` is the board's first landing, which renders in place. */
export type NameSwap = { text: string; prev: string | null; key: number };

/** The hub's tile mid-swap, on the same terms, keyed by executable rather than
 *  by name: a display name can change under a running programme without the
 *  programme changing. */
export type IconSwap = {
  exe: string;
  prev: { exeName: string; name: string } | null;
  key: number;
};

/**
 * Who this board is drawing, and the two swaps that report it changing.
 *
 * Held here rather than in the hub card because the card remounts on every
 * programme switch (`key={session.pid}`): a swap inside it would be reset by the
 * very switch it describes, and the words would simply be there. One level up,
 * a switch is a prop change and the remount carries the swap in.
 */
export function useHubIdentity(selectedPids: number[], sessions: AudioSession[]) {
  const pid = selectedPids[0];
  const session = sessions.find((s) => s.pid === pid);
  const name = session?.display_name ?? session?.exe_name;
  // The hub card remounts on every programme switch (`key={session.pid}` on
  // the button), which would reset a name swap held inside the card — the
  // words would simply be there, animation dropped on the floor. Tracked one
  // level up, where the switch is just a prop change, the remount instead
  // carries the swap in: ghost and arrivals play on the fresh mount exactly
  // as they would in place.
  const hubName = clampHubName(name ?? '');
  /** The programme the two swap states below were last adjusted for. Switching
   *  between siblings of one executable — same words, same tile, another pid —
   *  remounts the card without changing either. Left alone, the stale `prev`
   *  of the last real swap replays on the fresh mount: the previous
   *  programme's name and icon flash back for one beat before the (unchanged)
   *  answer settles. A remount that changes nothing resets both to render in
   *  place, so only a real swap ever speaks. */
  const swapPidRef = useRef(pid);
  const [nameSwap, setNameSwap] = useState<NameSwap>({
    text: hubName,
    prev: null,
    key: 0,
  });
  if (hubName !== nameSwap.text) {
    setNameSwap({ text: hubName, prev: nameSwap.text, key: nameSwap.key + 1 });
  } else if (pid !== swapPidRef.current && (nameSwap.prev !== null || nameSwap.key !== 0)) {
    setNameSwap({ text: hubName, prev: null, key: 0 });
  }
  // The tile swaps on the executable, not the name — a display_name can change
  // under a running programme without the programme changing. The ghost tile's
  // fallback letter reads the name this render is replacing (nameSwap still
  // holds it here, both adjustments reading pre-update state), so a
  // not-yet-loaded icon dissolves as a letter instead of a blank.
  const exe = session?.exe_name ?? '';
  // Sounding, subscribed per programme rather than as the whole table: any
  // program in the system flipping play/pause rebuilds the fold, and the board
  // owes a repaint only to the programme it draws (its feeders are covered by
  // their own selector below). The snapshot is one primitive, so a stable false
  // costs no re-render — and it is the programme's answer, not this one
  // process's, because the sound is usually made by a sibling.
  const hubExeKey = exe.toLowerCase();
  const sounding = useRouterStore((s) => s.soundingExes[hubExeKey] === true);
  const [iconSwap, setIconSwap] = useState<IconSwap>({ exe, prev: null, key: 0 });
  if (exe !== iconSwap.exe) {
    setIconSwap({
      exe,
      prev: iconSwap.exe ? { exeName: iconSwap.exe, name: nameSwap.text || iconSwap.exe } : null,
      key: iconSwap.key + 1,
    });
  } else if (pid !== swapPidRef.current && (iconSwap.prev !== null || iconSwap.key !== 0)) {
    // The sibling switch: the tile is already the right one, so the last swap's
    // ghost must not replay on the remounted card.
    setIconSwap({ exe, prev: null, key: 0 });
  }
  swapPidRef.current = pid;

  return { pid, session, name, exe, hubName, sounding, nameSwap, iconSwap };
}
