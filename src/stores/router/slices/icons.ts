import * as api from '@/lib/invoke';
import { rgbaToDataUrl } from '@/lib/icons';
import {
  clearIconRetry,
  clearIconTimer,
  iconRetries,
  iconRetryTimers,
  iconsInFlight,
  scheduleIconRetry,
} from '../gates';
import type { GetRouterState, IconsActions, SetRouterState } from '../types';

/** The icon asks, one per executable, behind the list and never in front of it.
 *
 *  The in-flight set, the retry timers and the spent budget are module-level
 *  (`../gates`) and shared with nothing else: one ask per exe per run is the
 *  whole point, and a second copy of that bookkeeping would put two writers
 *  back on one map entry. */
export function createIconsSlice(set: SetRouterState, get: GetRouterState): IconsActions {
  return {
    loadMissingIcons: () => {
      // Exes no longer on either list are not our business: a retry timer aimed
      // at a departed process would only fire into an empty pass, and its spent
      // budget would follow the process around if it ever came back.
      const live = new Set<string>();
      for (const session of get().sessions) live.add(session.exe_name);
      for (const app of get().windowApps) live.add(app.exe_name);
      for (const exeName of [...iconRetryTimers.keys()]) {
        if (!live.has(exeName)) clearIconRetry(exeName);
      }
      for (const exeName of [...iconRetries.keys()]) {
        if (!live.has(exeName)) iconRetries.delete(exeName);
      }

      // One ask per executable per pass: the icon belongs to the file, and the
      // first entry's pid is as good an address as any of its siblings'. The
      // windowed apps ride the same pass — the feed picker names them, so they
      // carry icons like the session list does.
      const asked = new Set<string>();
      // The retry's way back into the store: the timer asks the live store, not
      // this pass, for the icons still missing when it fires.
      const ask = () => get().loadMissingIcons();
      for (const session of [...get().sessions, ...get().windowApps]) {
        const exeName = session.exe_name;
        if (asked.has(exeName)) continue;
        asked.add(exeName);
        // A data URL is final. `null` and "not asked yet" both fall through:
        // a miss is retried — first on its own, then on the next refresh —
        // never held against the exe.
        if (typeof get().iconByExe[exeName] === 'string') {
          clearIconRetry(exeName);
          continue;
        }
        if (iconsInFlight.has(exeName)) continue;
        // A pending retry is moot: this pass is what it was waiting for.
        clearIconTimer(exeName);
        iconsInFlight.add(exeName);
        api
          .getProcessIcon(session.pid)
          .then((icon) => {
            const url = icon === null ? null : rgbaToDataUrl(icon);
            set((s) => ({ iconByExe: { ...s.iconByExe, [exeName]: url } }));
            if (typeof url === 'string') clearIconRetry(exeName);
            else scheduleIconRetry(exeName, ask);
          })
          .catch(() => {
            // Same settlement as "the file has no icon": the letter tile stays
            // for now, the retry asks again on its own, and nothing anywhere
            // logs an icon.
            set((s) => ({ iconByExe: { ...s.iconByExe, [exeName]: null } }));
            scheduleIconRetry(exeName, ask);
          })
          .finally(() => {
            iconsInFlight.delete(exeName);
          });
      }
    },
  };
}
