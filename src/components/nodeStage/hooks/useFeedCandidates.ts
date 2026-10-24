import { useMemo } from 'react';
import type { AudioSession } from '@/lib/types';

/**
 * The add menu's programme-input rows.
 *
 * The apps already holding a session while the query is empty, and — once the
 * user types — every windowed app the pool holds too. One row per program either
 * way, because the rule is per program and a second row for a sibling would stage
 * the same rule twice.
 */
export function useFeedCandidates({
  sessions,
  windowApps,
  pid,
  session,
  planFeedSessions,
  feedQuery,
}: {
  sessions: AudioSession[];
  windowApps: AudioSession[];
  pid: number | undefined;
  session: AudioSession | undefined;
  planFeedSessions: AudioSession[];
  feedQuery: string;
}) {
  /** The add menu's programme-input rows: the apps already holding a session
   *  while the query is empty, and — once the user types — every windowed app
   *  the pool holds too. One row per program either way, because the rule is
   *  per program and a second row for a sibling would stage the same rule
   *  twice. Neither the programme being drawn nor one of its own siblings (a
   *  feed into itself), and no programme the plan already names. */
  const feedCandidates = useMemo(() => {
    const hubExe = (session?.exe_name ?? '').toLowerCase();
    const plannedExes = new Set(planFeedSessions.map((s) => s.exe_name.toLowerCase()));
    const query = feedQuery.trim().toLowerCase();
    const seen = new Set<string>();
    const candidates: AudioSession[] = [];
    for (const s of [...sessions, ...windowApps]) {
      const exeKey = s.exe_name.toLowerCase();
      if (s.pid === pid || exeKey === hubExe || plannedExes.has(exeKey) || seen.has(exeKey)) {
        continue;
      }
      if (query !== '') {
        const matches =
          exeKey.includes(query) || (s.display_name ?? '').toLowerCase().includes(query);
        if (!matches) continue;
      } else if (!sessions.includes(s)) {
        // The second tier waits for a query: the menu opens exactly as long as
        // the session list, and any running app arrives with the first
        // keystroke — the list's length never becomes the process count.
        continue;
      }
      seen.add(exeKey);
      candidates.push(s);
    }
    return candidates;
  }, [sessions, windowApps, pid, session, planFeedSessions, feedQuery]);

  return feedCandidates;
}
