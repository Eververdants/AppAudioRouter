import i18next from 'i18next';
import * as api from '@/lib/invoke';
import { programEntryOf } from '@/lib/routes';
import { autoRestoreDecided, queueAssignmentWork } from '../gates';
import { AUTO_REMEMBER_STORAGE_KEY, pickRestorable } from '../pure/memory';
import { deviceName } from '../pure/targets';
import type { GetRouterState, MemoryActions, SetRouterState } from '../types';

/** The route memory and the restore pass that reads it.
 *
 *  Both halves are keyed by executable, never by display name; the restore
 *  claims a pid once and for all (`autoRestoreDecided` is never pruned against
 *  liveness — a pid that disappeared must not be retried), and it is queued
 *  behind the stale sweep rather than run beside it. */
export function createMemorySlice(set: SetRouterState, get: GetRouterState): MemoryActions {
  return {
    toggleAutoRemember: () => {
      const next = !get().autoRemember;
      set({ autoRemember: next });
      try {
        localStorage.setItem(AUTO_REMEMBER_STORAGE_KEY, next ? '1' : '0');
      } catch {
        /* storage may be unavailable; the preference just does not persist */
      }
      // Turning it on asks for the routes that are already remembered, not for a
      // promise about the next time something happens to move in the audio graph.
      if (next) queueAssignmentWork(() => get().restoreRememberedRoutes());
    },

    loadRememberedRoutes: async () => {
      try {
        const routes = await api.getRememberedRoutes();
        set({
          rememberedRoutes: routes.map(([exeName, deviceIds]) => ({ exeName, deviceIds })),
        });
      } catch (e) {
        get().addLog(i18next.t('log.rememberedRoutesFailed', { error: String(e) }), 'error');
        return;
      }
      // The device list, the process list and the memory arrive in no particular
      // order, and a restore needs all three — so whichever lands last is the one
      // that can actually do something, and each of them asks.
      queueAssignmentWork(() => get().restoreRememberedRoutes());
    },

    restoreRememberedRoutes: async () => {
      const { autoRemember, applying, rememberedRoutes, routedPids, devices, sessions } = get();
      if (!autoRemember || rememberedRoutes.length === 0) return;
      // A route the user is applying right now already owns these processes.
      // Nothing is claimed here, so the next pass picks them up again.
      if (applying) return;
      const targets = pickRestorable(sessions, rememberedRoutes, routedPids, devices);
      if (targets.length === 0) return;
      // Claimed before the first await: a refresh landing while these are in
      // flight must not start a second engine for the same process.
      for (const target of targets) autoRestoreDecided.add(target.pid);

      const results = await Promise.allSettled(
        targets.map(async (target) => {
          // The snapshot holds the order the user last landed, primary first —
          // it replays as is. Not re-remembered — it came out of the memory.
          const ordered = [...target.deviceIds];
          const generation = await api.applyRoute(target.pid, target.exeName, ordered, false);
          return { target, ordered, generation };
        }),
      );

      const restored: Record<number, string[]> = {};
      const generations: Record<number, number> = {};
      results.forEach((result, index) => {
        const target = targets[index];
        if (result.status === 'fulfilled') {
          const { ordered, generation } = result.value;
          if (target === undefined) return;
          restored[target.pid] = [...ordered];
          generations[target.pid] = generation;
          const copies = ordered.length - 1;
          get().addLog(
            i18next.t(copies > 0 ? 'log.routeRestoredMulti' : 'log.routeRestored', {
              process: target.exeName,
              device: deviceName(ordered[0], devices),
              m: copies,
            }),
            'info',
          );
        } else {
          // Left claimed: retrying on every refresh would fill the log with the
          // same failure, and the program can still be routed by hand.
          get().addLog(
            i18next.t('log.routeRestoreFailed', {
              process: target?.exeName ?? '',
              error: String(result.reason),
            }),
            'error',
          );
        }
      });
      if (Object.keys(restored).length === 0) return;
      set((s) => {
        const routedPids = { ...s.routedPids };
        const engineGenerations = { ...s.engineGenerations };
        for (const [pidKey, ids] of Object.entries(restored)) {
          const pid = Number(pidKey);
          // Something claimed this program while the restore was in flight — the
          // user applied a route, an undo put the old devices back, a sibling
          // landed one. That route owns the badge and the engine identity: the
          // remembered list written over it would name devices the engine is not
          // playing, and wearing this generation would make every later event of
          // the live engine read as stale — the same reason the stops below merge
          // rather than restore their snapshot.
          if (programEntryOf(s.sessions, routedPids, pid) !== undefined) continue;
          if (engineGenerations[pid] !== undefined) continue;
          routedPids[pid] = ids;
          const generation = generations[pid];
          if (generation !== undefined) engineGenerations[pid] = generation;
        }
        return { routedPids, engineGenerations };
      });
      // A restored route starts an engine just like a manual one, and the boot
      // reconciliation ran alongside this pass rather than after it — so without
      // this, routes restored at launch would carry no reading until the user
      // happened to apply something by hand.
      await get().reconcileActiveDuplications();
    },

    forgetRememberedRoute: async (exeName) => {
      const previous = get().rememberedRoutes;
      // Matched on the lowercased name like every other read of this memory — the
      // backend forgets case-insensitively, so a spelling-sensitive filter here
      // would leave the row standing for a route the file no longer carries, and
      // the next apply would write it straight back.
      const key = exeName.toLowerCase();
      set({ rememberedRoutes: previous.filter((entry) => entry.exeName.toLowerCase() !== key) });
      try {
        await api.clearRoute(exeName);
        get().addLog(i18next.t('log.rememberedRouteCleared', { process: exeName }), 'info');
      } catch (e) {
        // The file still carries it, so the list must too: showing a route as
        // forgotten while the next launch restores it is the worse lie. Only this
        // executable's own rows go back, though — the array as it stood before the
        // await can be a stale picture of somebody else's memory, since a route
        // applied meanwhile rewrites its row, and restoring the whole list would put
        // that row's old device list back on the settings page. Order is not
        // load-bearing here (this list is not numbered the way the feed board is), so
        // the row rejoins at the end.
        set((s) => {
          const gone = previous.filter((entry) => entry.exeName.toLowerCase() === key);
          if (gone.length === 0) return {};
          if (s.rememberedRoutes.some((entry) => entry.exeName.toLowerCase() === key)) return {};
          return { rememberedRoutes: [...s.rememberedRoutes, ...gone] };
        });
        get().raiseError(
          i18next.t('log.rememberedRouteClearedFailed', { process: exeName, error: String(e) }),
        );
      }
    },
  };
}
