import { useMemo } from 'react';

import { programRoutes } from '@/lib/routes';
import { useRouterStore } from '@/stores/routerStore';

/**
 * The route of every process's program, keyed by process id — the view the
 * board and the rail draw with, where a program's sibling processes carry the
 * same route as the one holding it.
 *
 * The Status page uses it only to compare the staged plan with what is live
 * (`alreadyApplied`); its rows read the route table by the session's own pid,
 * because it needs **one row per program** and the folded view would repeat a
 * browser's dozen processes.
 *
 * Derived, never stored: it is a function of the session list and the live
 * routes, and both move from several places, so a kept copy would only be a
 * chance to drift. The memo keeps it off the render path between those
 * changes — a store selector returning a fresh object on every call would
 * re-render forever.
 */
export function useProgramRoutes(): Record<number, string[]> {
  const sessions = useRouterStore((s) => s.sessions);
  const routedPids = useRouterStore((s) => s.routedPids);
  return useMemo(() => programRoutes(sessions, routedPids), [sessions, routedPids]);
}
