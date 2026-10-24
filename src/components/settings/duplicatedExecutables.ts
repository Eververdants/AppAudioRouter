import type { AudioSession } from '@/lib/types';

/**
 * The executables this app is duplicating right now, one entry per program.
 *
 * Duplicating, not merely routed: a route to a single device is played by the
 * system directly and starts no engine at all, so there is no gain path for a
 * level to travel and no level to set — the same rule that decides which source
 * nodes on the routing board wear a dial. A program with no route is out for
 * the same reason.
 *
 * The level belongs to the program, not to a process — a browser is a dozen
 * PIDs all playing the same thing — so the names are deduplicated by
 * executable.
 *
 * Ordered as the session list is, which is already by executable name, so the
 * rows do not shuffle between refreshes.
 */
export function duplicatedExecutables(
  sessions: AudioSession[],
  routedPids: Record<number, string[]>,
): string[] {
  const names: string[] = [];
  for (const session of sessions) {
    if ((routedPids[session.pid]?.length ?? 0) < 2) continue;
    if (!names.includes(session.exe_name)) names.push(session.exe_name);
  }
  return names;
}
