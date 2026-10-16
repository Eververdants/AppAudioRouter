import type { AudioSession } from '@/lib/types';

/**
 * Which entry of a per-program map answers for a process.
 *
 * Every key this app writes — the route, the feed, and the per-app output
 * assignment behind both — belongs to the *executable*, not to a process: the
 * audio service keeps one assignment per image, one route is applied per
 * program (the lowest pid of it), and a browser with a dozen processes has one
 * of each. Those maps are therefore keyed by the single pid that holds the
 * entry, and every other process of the same program has to resolve to it
 * before it can look anything up.
 *
 * Returns `pid` itself when it holds an entry, otherwise the sibling process
 * that does, otherwise `undefined` — the program has no entry at all. Empty
 * entries are treated as absent: they cannot occur (the store prunes them), and
 * reading one as an answer would say a program is routed to nothing.
 */
export function programEntryOf<T>(
  sessions: AudioSession[],
  map: Record<number, T[]>,
  pid: number,
): number | undefined {
  const own = map[pid];
  if (own !== undefined && own.length > 0) return pid;
  const session = sessions.find((s) => s.pid === pid);
  if (session === undefined) return undefined;
  const exe = session.exe_name.toLowerCase();
  for (const raw of Object.keys(map)) {
    const other = Number(raw);
    if (other === pid) continue;
    const ids = map[other];
    if (ids === undefined || ids.length === 0) continue;
    const sibling = sessions.find((s) => s.pid === other);
    if (sibling !== undefined && sibling.exe_name.toLowerCase() === exe) return other;
  }
  return undefined;
}

/**
 * The process holding each program's entry, for a whole list at once: the same
 * answer `programEntryOf` gives per process, folded in two passes so a list
 * that draws one row per process does not re-scan the sessions — and every
 * other program's entries — for what its neighbour already knows.
 *
 * Every process of a program maps to that program's holder, so a row can name
 * the entry to address without knowing which of its siblings landed it.
 */
export function programOwners<T>(
  sessions: AudioSession[],
  map: Record<number, T[]>,
): Record<number, number> {
  const holderByExe = new Map<string, number>();
  for (const session of sessions) {
    if ((map[session.pid]?.length ?? 0) === 0) continue;
    const key = session.exe_name.toLowerCase();
    const known = holderByExe.get(key);
    // The lowest pid, like the address every write to these maps uses.
    if (known === undefined || session.pid < known) holderByExe.set(key, session.pid);
  }
  const owners: Record<number, number> = {};
  for (const session of sessions) {
    owners[session.pid] = holderByExe.get(session.exe_name.toLowerCase()) ?? session.pid;
  }
  return owners;
}

/**
 * The route of the program each process belongs to, keyed by process id.
 *
 * `routedPids` holds one entry per routed program, under the pid it was applied
 * to. Everything that draws a route **per process** — the rail row, the board,
 * the Status page's staged-vs-live comparison — asks by the process it is
 * drawing, and a program's sibling processes have to read the same route as the
 * one holding it: left to the raw entry they would describe a program that is
 * not routed and offer no way out of a route that is running. Callers that need
 * one entry per program (the Status page's rows, the routed capsule) read the
 * raw table instead, keyed by the owner.
 */
export function programRoutes(
  sessions: AudioSession[],
  routedPids: Record<number, string[]>,
): Record<number, string[]> {
  // Fold the routed entries onto their executable first, so the per-process
  // pass below is one lookup each rather than a scan of the routed list per row.
  const byExe = new Map<string, string[]>();
  for (const raw of Object.keys(routedPids)) {
    const pid = Number(raw);
    const ids = routedPids[pid];
    if (ids === undefined || ids.length === 0) continue;
    const session = sessions.find((s) => s.pid === pid);
    if (session !== undefined) byExe.set(session.exe_name.toLowerCase(), ids);
  }
  if (byExe.size === 0) return {};
  const routes: Record<number, string[]> = {};
  for (const session of sessions) {
    const ids = byExe.get(session.exe_name.toLowerCase());
    if (ids !== undefined) routes[session.pid] = ids;
  }
  return routes;
}
