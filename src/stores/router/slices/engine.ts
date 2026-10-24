import i18next from 'i18next';
import * as api from '@/lib/invoke';
import {
  beginReconciliation,
  invalidateReconciliation,
  isCurrentReconciliation,
  queueAssignmentWork,
} from '../gates';
import { foldSounding } from '../pure/processes';
import { deviceName, feedTargetsOf } from '../pure/targets';
import type { EngineActions, GetRouterState, SetRouterState } from '../types';

/** The backend's own events folded in, and the one pass that re-reads which
 *  engines are alive.
 *
 *  Every handler here that changes an engine's life is followed by a
 *  reconciliation or by the retirement of the outstanding ask — there is no
 *  timer anywhere, so nothing else ever re-reads the picture. The generation
 *  guards reject the events of engines that have already been replaced. */
export function createEngineSlice(set: SetRouterState, get: GetRouterState): EngineActions {
  return {
    handleDuplicationReady: () => {
      // The engines have just answered for the first time, so their devices now
      // have readings where they had none. Nothing else asks again — a reading is
      // not a route action — so this is the event that makes the number appear
      // with the route instead of waiting for an unrelated one.
      void get().reconcileActiveDuplications();
    },

    handleDuplicationStopped: (event) => {
      const { pid, generation, reason, error } = event;
      // `stopped` is the ack of an explicit stop or re-route, both of which
      // already updated routedPids synchronously — the event may arrive after a
      // newer route was applied, so it must not clear state here.
      if (reason === 'stopped') return;
      // An engine that exists only for a feed tap — a programme being fed but not
      // routed — carries no generation on the board, so the guard below would
      // swallow its death and leave a wire that moves nothing. That failure is the
      // feed's to report, and it is reported on the feed's channel. The gate is
      // the programme's own feed plan: without it, the death of any engine whose
      // generation the board has already retired — a stop's second retirement, a
      // reconciliation that landed first — would read as a dead wire for a
      // programme that feeds nothing.
      if (
        reason === 'error' &&
        get().engineGenerations[pid] === undefined &&
        feedTargetsOf(get(), pid).length > 0
      ) {
        get().handleFeedTapFailed({ pid, generation, error: error ?? '' });
        return;
      }
      // Reject stale events before logging too: an old engine must not produce a
      // misleading failure line for a route that has already been replaced.
      if (generation !== (get().engineGenerations[pid] ?? 0)) return;
      // The engine is down and nothing is going to start it again, so whatever ask is
      // still holding its picture is retired here. Both branches below end the route,
      // and the process-exited one has no stop to lean on: the session refresh that
      // would prune a revived badge can easily have run *before* the late reply
      // lands, which leaves a route drawn as playing for a program that has left, for
      // the rest of the session on a quiet machine.
      invalidateReconciliation();
      if (reason === 'error') {
        get().raiseError(i18next.t('log.duplicationFailed', { pid, error: error ?? '' }), {
          detail: error ?? undefined,
          sticky: true,
        });
        // End it the way a stop ends it, and it has to be the stop. The engine
        // took its mirrors down with itself but not the endpoint Windows was told
        // to play this program on. Cleared locally only, that assignment stays
        // marked as a live route: the settings reset skips every executable with
        // one, the stale sweep skips every live pid, and the board has no route
        // left for the user to stop — so the only way back would be quitting the
        // app, which is the dead end 2.1.1 exists to close.
        void get().stopRoute(pid);
        return;
      }
      set((s) => {
        const routedPids = { ...s.routedPids };
        delete routedPids[pid];
        const engineGenerations = { ...s.engineGenerations };
        delete engineGenerations[pid];
        // A route is the program's and is held by one of its processes, but the
        // selection is drawn per process: with the engine down, the program's
        // siblings carry a plan for a route that no longer runs, and they leave
        // the selection with it — the same rule a manual stop follows. When the
        // dead pid has already left the session list its executable cannot be
        // named, and only its own selection can go.
        const endedExe = s.sessions.find((x) => x.pid === pid)?.exe_name.toLowerCase();
        const selectedPids = s.selectedPids.filter((p) => {
          if (p === pid) return false;
          if (endedExe === undefined) return true;
          return s.sessions.find((x) => x.pid === p)?.exe_name.toLowerCase() !== endedExe;
        });
        return {
          routedPids,
          engineGenerations,
          selectedPids,
          selectedDeviceIds: selectedPids.length === 0 ? [] : s.selectedDeviceIds,
        };
      });
      get().addLog(i18next.t('log.duplicationProcessExited', { pid }), 'info');
      // The program left with its session, so its assignment can only be released
      // through whichever process comes next — which is what the stale sweep
      // borrows. It is asked here rather than left to a session refresh, because
      // the refresh's own trigger reads the route list this just cleared: waiting
      // for it to notice the death can mean it never is.
      queueAssignmentWork(() => get().releaseStaleRoutes());
    },

    handleSessionActivity: ({ pid, active }) => {
      set((s) => {
        // Every reading this keeps has to be nameable by the fold, or the two
        // tables answer the same question differently: a process the list has
        // not reported yet has no executable to fold under, so recording it here
        // is a reading nothing keyed by program can see. Its arrival is the
        // re-enumeration's own job — that pass carries the `playing` flag, and
        // with it both tables.
        if (!s.sessions.some((session) => session.pid === pid)) return {};
        const soundingPids = { ...s.soundingPids };
        if (active) soundingPids[pid] = true;
        else delete soundingPids[pid];
        return { soundingPids, soundingExes: foldSounding(s.sessions, soundingPids) };
      });
    },

    handleMirrorFailed: (event) => {
      const { pid, generation, deviceId, error } = event;
      // The same staleness guard as the engine-level event: a mirror belonging to
      // a route that has already been replaced must not edit the current one.
      if (generation !== (get().engineGenerations[pid] ?? 0)) return;
      const routed = get().routedPids[pid];
      if (routed === undefined || !routed.includes(deviceId)) return;
      // A reconciliation asked before this event still names the device that just
      // went quiet: its reply would redraw the badge with it, bring the pulse back,
      // and hand a latency reading to a stream the engine no longer writes — the lie
      // this event exists to report. The engine itself keeps running, so the ask is
      // retired rather than replaced; the next one re-reads the whole list.
      invalidateReconciliation();
      // The first id is the primary — the endpoint the OS plays natively — and the
      // backend reports a mirror, never the primary: an engine holds its primary
      // apart from the copies it duplicates to. So a device reported at that
      // position means this store and the engine disagree about the route, and
      // simply dropping it would promote the next device into the primary slot —
      // a copy the engine is still duplicating to, now drawn as the one Windows
      // plays directly. The honest answer is to end the route instead of
      // reassigning its roles.
      if (routed[0] === deviceId) {
        get().raiseError(i18next.t('log.duplicationFailed', { pid, error }), {
          detail: error,
          sticky: true,
        });
        // Same reasoning as an engine that stops by itself: this ends the route,
        // so it ends it through the stop, which is the path that hands the
        // program's endpoint back. The clear below would leave the badge gone and
        // the assignment pinned as a live route — unreachable from the board, and
        // skipped by both the reset and the sweep.
        void get().stopRoute(pid);
        return;
      }
      // The device is not playing anything, so it must not keep the live badge and
      // pulse that say otherwise. The rest of the route is unaffected.
      set((s) => ({
        routedPids: { ...s.routedPids, [pid]: routed.filter((id) => id !== deviceId) },
      }));
      get().raiseError(
        i18next.t('log.mirrorFailed', { device: deviceName(deviceId, get().devices), error }),
      );
    },

    handleFeedTapFailed: (event) => {
      const { pid, generation, error } = event;
      // The same staleness rule the other engine events follow, with one hole
      // that has to stay open: an engine that exists only for a feed tap has no
      // route badge and therefore no generation in this store (0). Its own
      // failures must still land, or a tap that dies is silent — the state these
      // rows exist to show.
      const known = get().engineGenerations[pid];
      if (known !== undefined && known !== generation) return;
      const session = get().sessions.find((s) => s.pid === pid);
      if (session === undefined) return;
      const exeKey = session.exe_name.toLowerCase();
      set((s) => ({ feedTapFailures: { ...s.feedTapFailures, [exeKey]: error } }));
      get().raiseError(i18next.t('log.feedTapFailed', { source: session.exe_name }), {
        detail: error,
      });
    },

    reconcileActiveDuplications: async () => {
      // The webview can reload while the native process keeps duplication engines
      // alive, so ask the backend for their exact ordered device lists and restore
      // the badges with the data the UI needs.
      const flight = beginReconciliation();
      try {
        const active = await api.getActiveDuplications();
        if (!isCurrentReconciliation(flight)) return;
        const activePids = new Set(active.map((route) => route.pid));
        // An empty list means the device list has not arrived yet (boot), not
        // that every device is gone — the same guard the restore pass uses.
        const devices = get().devices;
        const liveDeviceIds = new Set(devices.map((device) => device.id));
        const routesEnded: number[] = [];
        set((s) => {
          const routedPids = { ...s.routedPids };
          const engineGenerations = { ...s.engineGenerations };
          // A multi-device route has an engine, and this list is the authority on
          // which of those engines are alive. A badge whose engine is gone — a
          // re-route whose new engine never started (every apply tears the old
          // one down first), an event lost while the webview was busy — describes
          // a route that no longer exists, so it goes with the generation it
          // stood on. A single-device route has no engine at all (generation 0,
          // never in this list) and is the session list's to retire, not this
          // one's.
          for (const pid of Object.keys(routedPids)) {
            const numericPid = Number(pid);
            if ((engineGenerations[numericPid] ?? 0) > 0 && !activePids.has(numericPid)) {
              delete routedPids[numericPid];
              delete engineGenerations[numericPid];
            }
          }
          // Rebuilt rather than merged, like the badges above: only the devices an
          // engine is driving right now keep a reading. Each badge is also
          // intersected with the live device list — refreshDevices drops dead
          // devices from these same badges, and writing them back here would undo
          // that filter on every notification pass. A route left with no live
          // device is over: its engine keeps running (process loopback capture
          // does not end when a device does) and its endpoint assignment stays
          // booked, so it is stopped here — directly, not through the stop
          // action, whose promise to a manual stop is to forget the memory, and
          // an unplug must not erase the user's rule.
          const deviceLatencyMs: Record<string, number> = {};
          for (const route of active) {
            if (route.deviceIds.length === 0) continue;
            const liveIds =
              devices.length > 0
                ? route.deviceIds.filter((id) => liveDeviceIds.has(id))
                : route.deviceIds;
            if (liveIds.length === 0) {
              if ((engineGenerations[route.pid] ?? 0) === route.generation) {
                delete routedPids[route.pid];
                delete engineGenerations[route.pid];
                routesEnded.push(route.pid);
              }
              continue;
            }
            routedPids[route.pid] = liveIds;
            engineGenerations[route.pid] = route.generation;
            // Index 0 is the primary, which Windows plays natively and which
            // reports `null` because there is no stream of ours to ask. Every
            // entry past it is a mirror, and its reading is what the stage shows.
            for (let index = 1; index < route.deviceIds.length; index += 1) {
              const deviceId = route.deviceIds[index];
              const latencyMs = route.latencyMs[index];
              if (deviceId === undefined || latencyMs === undefined || latencyMs === null) continue;
              if (devices.length > 0 && !liveDeviceIds.has(deviceId)) continue;
              deviceLatencyMs[deviceId] = latencyMs;
            }
          }
          return { routedPids, engineGenerations, deviceLatencyMs };
        });
        for (const pid of routesEnded) {
          api.stopRoute(pid).catch(() => {
            /* best effort — the next reconcile pass finds the engine again */
          });
        }
      } catch {
        /* enumerating active engines is best-effort; the user can re-route */
      }
    },
  };
}
