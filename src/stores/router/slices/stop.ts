import i18next from 'i18next';
import * as api from '@/lib/invoke';
import {
  autoRestoreDecided,
  beginErrorBatch,
  endErrorBatch,
  invalidateReconciliation,
  retireStaleRevival,
} from '../gates';
import { isRememberableName } from '../pure/memory';
import { deviceName } from '../pure/targets';
import type { GetRouterState, RouteStopActions, SetRouterState } from '../types';

/** Taking routes down: the single undo offer (a snapshot, never a stack — and
 *  the memory follows it, because an undo that leaves its own write behind
 *  would re-apply the route the user just took back), one stop, and the batch
 *  stop that collapses its refusals into one card. */
export function createStopSlice(set: SetRouterState, get: GetRouterState): RouteStopActions {
  return {
    undoLastRoute: async () => {
      const snapshot = get().undoSnapshot;
      if (snapshot === null) return;
      // One user action, held against the same flighting flag an apply is: a
      // boot restore in flight for the same program must not race the re-route
      // below — two `apply_route` calls for one executable would leave the
      // board showing one device list while the engine plays the other until
      // the next reconciliation heals it.
      if (get().applying) return;
      set({ applying: true });
      // Consumed before the work starts: a second activation — or a route landing
      // while this unwinds — must not undo the same thing twice. It is also what
      // keeps the stops below from dropping the offer they are running from.
      set({ undoSnapshot: null });
      let failure: string | null = null;
      let memoryDiffers = false;
      try {
        for (const entry of snapshot.entries) {
          const previous = entry.previous;
          try {
            if (previous === null || previous.length === 0) {
              // Back to the system default through the same stop a manual one uses:
              // that is the path that releases the program's fixed endpoint, and one
              // left behind would hold it on a device the user thinks they left.
              await get().stopRoute(entry.pid);
              // A stop leaves the memory alone on purpose — a stopped route stays
              // remembered — but the apply wrote this program's memory, and leaving
              // that write behind would apply the route the user just undid the next
              // time the program starts. Putting the old memory back is not possible
              // without a command to write one, so it is cleared instead: losing a
              // route that was not in effect is the smaller loss.
              if (snapshot.remembered && isRememberableName(entry.exeName)) {
                await api.clearRoute(entry.exeName);
                memoryDiffers = true;
              }
              continue;
            }
            // The snapshot holds the order the user last landed, primary first —
            // it replays as is, the same promise the restore makes.
            const ordered = [...previous];
            // `remember` mirrors what the apply did, because that is what puts the
            // memory back: with it false the old device list would never be written
            // and the memory would keep naming the route being undone. The apply
            // only remembers programs it can name — a "PID 4321" matches no future
            // launch — and the undo holds itself to the same rule, or the settings
            // list grows a row that can never be found again.
            const remember = snapshot.remembered && isRememberableName(entry.exeName);
            const generation = await get().routeOne(entry.pid, entry.exeName, ordered, remember);
            if (remember) memoryDiffers = true;
            // Written here, one program at a time: an undo is a single user action
            // rather than a fan-out, and the generation is what a later
            // duplication-stopped event for this engine is measured against.
            set((s) => ({
              routedPids: { ...s.routedPids, [entry.pid]: [...ordered] },
              engineGenerations: { ...s.engineGenerations, [entry.pid]: generation },
            }));
          } catch (e) {
            // One line for the whole action, not one per program.
            failure ??= String(e);
          }
        }
        // Re-read rather than patch the mirror by hand: the backend is the truth for
        // what was written, and it is the state the settings list shows.
        if (memoryDiffers) await get().loadRememberedRoutes();
        // What this put back is duplicating now, so its readings are due for the
        // same reason a freshly applied route's are.
        await get().reconcileActiveDuplications();
      } finally {
        // Always handed back — an undo that fails part way must not leave the
        // hub latched against a still-routable selection.
        set({ applying: false });
      }
      if (failure === null) {
        get().addLog(i18next.t('log.routeUndone', { n: snapshot.entries.length }), 'info');
      } else {
        get().raiseError(i18next.t('log.routeUndoFailed', { error: failure }), {
          detail: failure,
        });
      }
    },

    dismissUndo: () => set({ undoSnapshot: null }),

    stopRoute: async (pid) => {
      const session = get().sessions.find((s) => s.pid === pid);
      // Snapshot before mutating: if the backend rejects the stop the UI must
      // keep showing the route as live instead of silently desyncing from it.
      const previous = get().routedPids[pid];
      if (previous === undefined) return;
      // The offer on screen describes the route this stop is taking apart, so it
      // is no longer the thing being offered: acting on it would undo the user's
      // last move instead of the one they meant to take back.
      set({ undoSnapshot: null });
      // The user just took this one off; a restore must not put it straight back.
      autoRestoreDecided.add(pid);
      const previousGeneration = get().engineGenerations[pid] ?? 0;
      const process = session?.exe_name ?? `PID ${pid}`;
      // A route is the program's but is held by one of its processes, and the
      // restore pass tries every executable at its *lowest* pid: claiming only
      // this pid let a route stopped from a sibling come straight back on the
      // program's own lowest process at the next refresh.
      const stoppedExe = session?.exe_name.toLowerCase();
      if (stoppedExe !== undefined) {
        for (const sibling of get().sessions) {
          if (sibling.exe_name.toLowerCase() === stoppedExe) autoRestoreDecided.add(sibling.pid);
        }
      }
      // What the optimistic clear takes out of the selection, so a refused stop
      // can put exactly that back — no more.
      let removedSelection: number[] = [];
      try {
        // Optimistic: reflect the stop immediately so the UI feels instant.
        invalidateReconciliation();
        set((s) => {
          const routedPids = { ...s.routedPids };
          delete routedPids[pid];
          // Gone rather than zeroed: `0` is what an entry that never had an engine
          // reads as, so leaving a zero behind is only a key that outlives its
          // route — and the event guards below compare against it either way.
          const engineGenerations = { ...s.engineGenerations };
          delete engineGenerations[pid];
          // A route belongs to a program and is held by one of its processes, but
          // the selection is drawn per process: the row that was pressed can be a
          // sibling of the holder. Every process of this executable then leaves
          // the selection with the route — leaving one behind would keep the
          // board showing a plan for a route that has just stopped.
          const selectedPids = s.selectedPids.filter(
            (p) =>
              p !== pid &&
              (stoppedExe === undefined ||
                s.sessions.find((x) => x.pid === p)?.exe_name.toLowerCase() !== stoppedExe),
          );
          removedSelection = s.selectedPids.filter((p) => !selectedPids.includes(p));
          return {
            routedPids,
            engineGenerations,
            selectedPids,
            selectedDeviceIds: selectedPids.length === 0 ? [] : s.selectedDeviceIds,
          };
        });
        const outcome = await api.stopRoute(pid);
        // Retire the asks made *after* the one above too. The engine comes down when
        // this call answers, and the teardown itself raises a Core Audio change, so a
        // reconciliation asked inside that window still pictures the live engine: its
        // reply would put the badge and the generation of an engine that has just gone
        // back on screen, and nothing asks a third time on a quiet machine. What this
        // can discard is a reading another route was owed — and an engine that starts
        // asks for its own through `duplication-ready`, so the cost is a figure that
        // waits, not a stopped route drawn as playing.
        invalidateReconciliation();
        // And take back the answer that landed before it could be retired: a reply
        // committing while this call was in the air has already been written, and it
        // drew the very engine this stop is taking down.
        retireStaleRevival(set, pid, previousGeneration);
        if (outcome.released) {
          get().addLog(i18next.t('log.routeStopped', { process }), 'info');
        } else if (outcome.sibling_held) {
          // The backend kept the assignment because another process of the same
          // program still holds a live route — the way out is stopping that
          // route, not the settings reset the pinned wording points at. Which of
          // its two failures this was is the backend's to say: the route list
          // still carries a dead sibling's entry, so reading it here would dress
          // a refused release up as a sibling route and swallow the device name.
          get().addLog(i18next.t('log.routeStoppedSibling', { process }), 'info');
        } else {
          // The program plays on the current default again, but Windows still
          // holds a fixed output device for it, and that has to be said out loud:
          // switching devices by hand will not move the program until the
          // assignment is released, and only the settings page can do that.
          const device = outcome.pinned_device;
          get().raiseError(
            device === null
              ? i18next.t('log.routeStoppedUnreleased', { process })
              : i18next.t('log.routeStoppedStillPinned', {
                  process,
                  device: deviceName(device, get().devices),
                }),
          );
        }
      } catch (e) {
        // Backend didn't actually stop: roll the route and its event identity
        // back — unless something took the seat while the stop was in flight, so
        // the entries the optimistic clear deleted have been written again by a
        // newer route. Restoring the snapshot over that would leave the new
        // route wearing the old engine's generation, and every later event for
        // the new engine would be dropped as stale.
        set((s) => {
          if (s.routedPids[pid] !== undefined || s.engineGenerations[pid] !== undefined) {
            return {};
          }
          return {
            routedPids: { ...s.routedPids, [pid]: previous },
            engineGenerations: { ...s.engineGenerations, [pid]: previousGeneration },
            // The route stays live, so its rows come back into the selection
            // too — the batch stop does the same for its failures, and a
            // refused single stop used to leave a live route with no selected
            // rows, the board drawing a route the selection no longer named.
            selectedPids: [
              ...s.selectedPids,
              ...removedSelection.filter((p) => !s.selectedPids.includes(p)),
            ],
          };
        });
        get().raiseError(i18next.t('log.stopRouteFailed', { error: String(e) }), {
          detail: String(e),
        });
      }
    },

    stopAllRoutes: async () => {
      const pids = Object.keys(get().routedPids).map(Number);
      if (pids.length === 0) return;
      // As with a single stop: the offer describes routes the user is taking apart
      // by hand right now, so it is not an offer any more.
      set({ undoSnapshot: null });
      const names = new Map(get().sessions.map((s) => [s.pid, s.exe_name] as const));
      // Same rule as a single stop: none of these may be restored under the user —
      // and claimed per executable, because the restore pass asks the lowest pid
      // of a program, which is not necessarily the one holding its route.
      const stoppedPrograms = new Set<string>();
      for (const pid of pids) {
        autoRestoreDecided.add(pid);
        const exe = names.get(pid)?.toLowerCase();
        if (exe !== undefined) stoppedPrograms.add(exe);
      }
      for (const [pid, name] of names) {
        if (stoppedPrograms.has(name.toLowerCase())) autoRestoreDecided.add(pid);
      }
      // Optimistic: assume every stop succeeds, then put back the ones that
      // didn't. Failed stops must keep their route live rather than desyncing
      // the UI from an engine that is still duplicating.
      const snapshot = { ...get().routedPids };
      const generationSnapshot = { ...get().engineGenerations };
      invalidateReconciliation();
      set({ routedPids: {}, engineGenerations: {} });
      // One card for this whole batch: a stop refused per route would replace the
      // notice before it as fast as the batch answers, and the tour's wipe —
      // which calls this — is one user action failing in several places at once.
      beginErrorBatch();
      const results = await Promise.allSettled(pids.map((pid) => api.stopRoute(pid)));
      const failed: number[] = [];
      const stillPinned: string[] = [];
      results.forEach((result, index) => {
        const pid = pids[index];
        if (pid === undefined) return;
        if (result.status === 'rejected') {
          failed.push(pid);
          get().raiseError(i18next.t('log.stopRouteFailed', { error: String(result.reason) }), {
            detail: String(result.reason),
          });
        } else if (!result.value.released && !result.value.sibling_held) {
          // Stopped, but the program keeps a fixed output device: one line for the
          // whole batch is enough, the single-stop case names the device. A stop
          // held by a sibling is not that: the sibling is in this same batch, and
          // whichever of the two lands last is the one that releases it — or says
          // so here.
          stillPinned.push(names.get(pid) ?? `PID ${pid}`);
        }
      });
      endErrorBatch(set);
      // Same second retirement as a single stop: an ask made while this batch was in
      // the air still lists engines that are now down. When every stop refused the
      // engines are all still running, so nothing is thrown away.
      if (failed.length < pids.length) invalidateReconciliation();
      for (const pid of pids) {
        // A stop that refused keeps its live route, so only the ones that came down
        // have a revival to take back.
        if (failed.includes(pid)) continue;
        const retired = generationSnapshot[pid];
        if (retired !== undefined) retireStaleRevival(set, pid, retired);
      }
      set((s) => {
        const routedPids = { ...s.routedPids };
        const engineGenerations = { ...s.engineGenerations };
        for (const pid of failed) {
          // Merge into what is here now rather than rebuilding from the
          // snapshot: a route applied while the batch was in flight has written
          // newer entries, and overwriting those with the pre-stop snapshot
          // would leave the new route wearing the old engine's generation —
          // every later event for it dropped as stale.
          if (routedPids[pid] !== undefined || engineGenerations[pid] !== undefined) continue;
          const restored = snapshot[pid];
          if (restored !== undefined) routedPids[pid] = restored;
          const generation = generationSnapshot[pid];
          if (generation !== undefined) engineGenerations[pid] = generation;
        }
        const stoppedExes = new Set<string>();
        for (const pid of pids) {
          if (failed.includes(pid)) continue;
          const name = names.get(pid);
          if (name !== undefined) stoppedExes.add(name.toLowerCase());
        }
        const selectedPids = s.selectedPids.filter((p) => {
          // A route is the program's but the selection is drawn per process, so
          // a sibling of one of these leaves the selection with it — standing
          // alone it would keep a stopped plan on the board with no route left
          // under it to stop.
          if (failed.includes(p)) return true;
          if (pids.includes(p)) return false;
          const name = names.get(p);
          return name === undefined || !stoppedExes.has(name.toLowerCase());
        });
        return {
          routedPids,
          selectedPids,
          selectedDeviceIds: selectedPids.length === 0 ? [] : s.selectedDeviceIds,
          engineGenerations,
        };
      });
      get().addLog(
        i18next.t('log.stoppedAll', { n: pids.length - failed.length }),
        failed.length > 0 ? 'error' : 'info',
      );
      if (stillPinned.length > 0) {
        get().addLog(
          i18next.t('log.stoppedAllStillPinned', {
            n: stillPinned.length,
            processes: stillPinned.join(', '),
          }),
          'error',
        );
      }
    },
  };
}
