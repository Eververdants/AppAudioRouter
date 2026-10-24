import { useMemo } from 'react';
import type { AudioSession } from '@/lib/types';
import { useRouterStore } from '@/stores/routerStore';

/**
 * The programmes sending sound into the hub, and which of them are sounding.
 *
 * Both are read through the program's *holder*, not the process the list
 * offered: a feed is stored under — and aimed at — the lowest pid of the
 * executable, while the board opens on whichever sibling the list happened to
 * offer. The sounding subset is a joined string snapshot for the same reason the
 * hub's ring is: only a flip inside this subset re-renders the board.
 */
export function useFeeders({
  pid,
  sessions,
  feeds,
}: {
  pid: number | undefined;
  sessions: AudioSession[];
  feeds: Record<number, number[]>;
}) {
  /** Programmes feeding sound *into* the hub, as sessions. */
  const feeders = useMemo(() => {
    if (pid === undefined) return [];
    // A feed is stored under — and aimed at — the program's lowest pid, while
    // the board opens on whichever process the list offered: the same address
    // `programEntryOf` resolves for the feeds going out, read from this side.
    // Matching the bare pid here left a browser's sibling show no feeder at all
    // — the wire, its card and the hub's in-pin were simply missing.
    const hubExe = sessions.find((s) => s.pid === pid)?.exe_name.toLowerCase();
    if (hubExe === undefined) return [];
    const answersForHub = (targetPid: number): boolean =>
      targetPid === pid ||
      sessions.find((s) => s.pid === targetPid)?.exe_name.toLowerCase() === hubExe;
    return Object.entries(feeds)
      .filter(([, targets]) => targets.some(answersForHub))
      .map(([sourcePid]) => sessions.find((s) => s.pid === Number(sourcePid)))
      .filter((s) => s !== undefined);
  }, [feeds, sessions, pid]);

  /** Which of the hub's feeders are sounding, as their executable names joined:
   *  a string snapshot, so only a flip inside this subset re-renders the board.
   *  Read per programme like the hub's own ring is. */
  const feederExeKeys = useMemo(
    () => feeders.map((feeder) => feeder.exe_name.toLowerCase()),
    [feeders],
  );
  const soundingFeederKey = useRouterStore((s) =>
    feederExeKeys.filter((feederExeKey) => s.soundingExes[feederExeKey] === true).join(','),
  );
  const soundingFeeders = useMemo(
    () => new Set(soundingFeederKey === '' ? [] : soundingFeederKey.split(',')),
    [soundingFeederKey],
  );

  return { feeders, soundingFeeders };
}
