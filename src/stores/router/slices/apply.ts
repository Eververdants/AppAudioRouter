import i18next from 'i18next';
import type { ReplacedRoute } from '@/lib/types';
import * as api from '@/lib/invoke';
import { alreadyApplied, effectiveFallback } from '@/lib/stage';
import { programEntryOf } from '@/lib/routes';
import { isRememberableName, rememberTargets } from '../pure/memory';
import { oneProcessPerExe, lowestPidByExe } from '../pure/processes';
import { deviceName, feedTargetsOf } from '../pure/targets';
import type { GetRouterState, RouteApplyActions, SetRouterState } from '../types';

/** Landing the staged device plan (and, in the same press, the staged feed
 *  plan). One press, two plans, each half moved only when it differs from the
 *  truth; the undo snapshot is taken before anything moves, and every path that
 *  starts or kills an engine is followed by one reconciliation. */
export function createApplySlice(set: SetRouterState, get: GetRouterState): RouteApplyActions {
  return {
    // The seam the routing paths in here share, and the only place this store
    // reaches for `applyRoute`: one program, one backend call, and the generation
    // of the engine it started. What that route means to the rest of the state is
    // the caller's to write — it is the only side that knows whether it is routing
    // one program or a whole selection.
    routeOne: (pid, exeName, deviceIds, remember) =>
      api.applyRoute(pid, exeName, deviceIds, remember),

    applyRoute: async () => {
      // A flighting request already owns the selection: a second click while the
      // first is in flight would dispatch a duplicate route against the same
      // targets. Let the first one land, then start from fresh state.
      if (get().applying) return;
      set({ applying: true });
      const {
        selectedPids,
        selectedDeviceIds,
        selectedFeedPids,
        autoRemember,
        sessions,
        windowApps,
      } = get();
      // One press can land two plans, and each half moves only when it differs
      // from the truth: the devices when the staged list is not what every
      // selected program already plays through, the feeds when the staged inputs
      // are not the hub program's live map. A feeds-only press must not write a
      // route nobody staged — an unrouted program pressed for a feed alone stays
      // unrouted, the same courtesy `alreadyApplied` grants a plan that only
      // names what the program already plays.
      //
      // The device half reads the same fold the board's pressability does: a
      // sibling selected under a routed owner is answered by the owner's route.
      // Comparing the raw pid list instead would call the press dirty and
      // re-route a program with the devices it already plays through — tearing
      // its engine down and back up for a press the board treats as a no-op.
      const routedNow = get().routedPids;
      const targets = oneProcessPerExe(sessions, selectedPids).map((target) => {
        const owner = programEntryOf(sessions, routedNow, target.pid);
        return owner === undefined || owner === target.pid ? target : { ...target, pid: owner };
      });
      const devicesDirty =
        selectedDeviceIds.length > 0 &&
        !alreadyApplied(
          selectedDeviceIds,
          targets.map((target) => target.pid),
          routedNow,
          effectiveFallback(get().defaultDeviceId, get().devices),
        );
      const hubPid = selectedPids[0];
      const feedOwner =
        hubPid !== undefined ? programEntryOf(sessions, get().feeds, hubPid) : undefined;
      const liveFeeds = feedOwner === undefined ? [] : (get().feeds[feedOwner] ?? []);
      const feedsDirty =
        selectedFeedPids.some((target) => !liveFeeds.includes(target)) ||
        liveFeeds.some((target) => !selectedFeedPids.includes(target));
      if (selectedPids.length === 0 || (!devicesDirty && !feedsDirty)) {
        set({ applying: false });
        if (selectedPids.length === 0)
          get().addLog(i18next.t('log.selectProcessAndDevice'), 'error');
        return;
      }
      // A program that already holds a route keeps it under the pid that owns
      // it, even when the selection names a sibling: landing on the sibling
      // would leave the owner's engine running next to the new one, and two
      // engines capturing one process tree is the comb filter `oneProcessPerExe`
      // exists to prevent. The undo snapshot reads the owner's route with it.
      if (targets.length === 0) {
        set({ applying: false });
        get().raiseError(i18next.t('log.processGone'));
        return;
      }
      // Counted against the list, not against the fold: a selection of four that
      // came down to two executables lost nothing, it merged — and "some processes
      // are gone" would report four deaths that did not happen.
      const gone = selectedPids.filter((pid) => !sessions.some((s) => s.pid === pid)).length;
      if (gone > 0) {
        get().addLog(i18next.t('log.someProcessesGone', { n: gone }), 'info');
      }

      // Apply in the plan's own order: the first device the user staged is the
      // one Windows plays natively, and the board previews exactly this order.
      // Delay values are the copies' compensation, not a vote on the seat —
      // reordering here would seat a device the user never picked (with
      // calibrated values the baseline sits at 0 and would always win it).
      const ordered = [...selectedDeviceIds];
      const deviceNames = ordered.map((id) => deviceName(id, get().devices));
      const primary = deviceNames[0];
      const extra = ordered.length - 1;
      // What this route is about to replace, read before anything moves: the offer
      // to undo it is only as honest as the state it was taken from.
      const replaced: ReplacedRoute[] = targets.map((target) => {
        const previous = get().routedPids[target.pid];
        return {
          pid: target.pid,
          exeName: target.exeName,
          previous: previous === undefined ? null : [...previous],
        };
      });
      try {
        // The device half moves only when the staged plan differs from the truth
        // (`devicesDirty`); a press that only lands feeds skips all of it.
        if (devicesDirty) {
          // One invoke per process, all of them in flight together: the backend
          // routes each PID on its own, so awaiting them in a loop simply added
          // their latencies up — a ten-process selection cost ten times one.
          const results = await Promise.allSettled(
            targets.map((target) =>
              get().routeOne(
                target.pid,
                target.exeName,
                ordered,
                autoRemember && isRememberableName(target.exeName),
              ),
            ),
          );
          const applied: { pid: number; exeName: string; generation: number }[] = [];
          const errors: string[] = [];
          results.forEach((result, index) => {
            const target = targets[index];
            if (target === undefined) return;
            if (result.status === 'fulfilled') {
              applied.push({ ...target, generation: result.value });
            } else {
              errors.push(String(result.reason));
            }
          });
          if (applied.length === 0) {
            get().raiseError(
              i18next.t('log.routeFailed', { error: errors[0] ?? 'unknown error' }),
              {
                detail: errors[0],
              },
            );
            // Every apply tears the selection's old engines down before it starts
            // new ones, so a rejected re-route has left the backend with no engine
            // for these pids while the badges above may still carry the old route.
            // Rebuilding from the live engines retires them — the same pass a
            // partial failure gets below. The feeds the same press asked for land
            // either way; each half of the press reports its own outcome.
            await get().reconcileActiveDuplications();
          } else {
            // What the offer to undo will cover: the programs this route was actually
            // accepted for, not every process that was selected.
            const accepted = new Set(applied.map((t) => t.pid));
            // Only the processes the backend actually accepted keep a badge, an engine
            // identity and a memory; a partial apply must not claim the rest. One
            // `set` for the whole batch, so the stage repaints once.
            set((s) => ({
              routedPids: {
                ...s.routedPids,
                ...Object.fromEntries(applied.map((t) => [t.pid, [...ordered]])),
              },
              selectedDeviceIds: ordered,
              // What was applied is the route now, and the plan goes back to tracking
              // it: a device returning to the list, a route the backend reports
              // differently, and the board redraws with them instead of keeping the
              // moment of the apply frozen on screen. The user's own staging is the
              // only thing that freezes it again.
              deviceSelectionPrefilled: true,
              // Mirrored locally so a program that plays again in this same session is
              // restored from what was just written, not from the boot-time copy.
              rememberedRoutes: autoRemember
                ? rememberTargets(
                    s.rememberedRoutes,
                    applied.map((t) => t.exeName).filter(isRememberableName),
                    ordered,
                  )
                : s.rememberedRoutes,
              engineGenerations: {
                ...s.engineGenerations,
                ...Object.fromEntries(applied.map((t) => [t.pid, t.generation])),
              },
              // This route is now what there is to undo, and it covers exactly the
              // programs it was accepted for — a previous offer is dropped with it.
              // The device it sent audio to rides along so the offer can name it.
              undoSnapshot: {
                entries: replaced.filter((entry) => accepted.has(entry.pid)),
                remembered: autoRemember,
                deviceName: primary ?? '',
                deviceCount: ordered.length,
              },
            }));
            const count = applied.length;
            // Both counts say something: how many programs went, and how many devices
            // each of them got. A route to three devices is not "routed to Speakers"
            // just because only one program was selected — the two copies are the
            // part worth reading about.
            const key =
              count > 1
                ? autoRemember
                  ? 'log.routedMultiProcessRemembered'
                  : 'log.routedMultiProcess'
                : extra > 0
                  ? autoRemember
                    ? 'log.routedMultiRemembered'
                    : 'log.routedMulti'
                  : autoRemember
                    ? 'log.routedRemembered'
                    : 'log.routed';
            get().addLog(
              i18next.t(key, {
                n: count,
                process: applied[0]?.exeName ?? '',
                device: primary,
                m: extra,
              }),
              'success',
            );
            if (errors.length > 0) {
              get().raiseError(
                i18next.t('log.routePartiallyFailed', {
                  ok: count,
                  n: targets.length,
                  error: errors[0],
                }),
              );
            }
            // The route is in effect and the 自动记忆 switch is on, so one of them did
            // not happen — say which and why, or the next launch looks like the switch
            // was ignored. Only reached for a process this app cannot open a file name
            // for, which is rare enough that a line in the log is the right cost.
            const skipped = applied
              .map((t) => t.exeName)
              .filter((name) => !isRememberableName(name));
            if (autoRemember && skipped.length > 0) {
              get().addLog(
                i18next.t('log.notRememberable', { process: skipped.join(', ') }),
                'info',
              );
            }
            // The engines are up now, and this is the only pass that asks each of them
            // how far behind its device plays. The badges above say what was applied;
            // this is what makes the readings appear with the route instead of waiting
            // for the next route, or for Core Audio to move.
            await get().reconcileActiveDuplications();
          }
        }

        // The feed half: the staged inputs go up, the live ones the plan dropped
        // come down — through the same primitives every landing uses, so the
        // memory, the restore claims and the honest three states stay in one
        // place. Only the board's own programme feeds here: a multi-selection
        // shares the device plan, never the feed plan.
        const hubSession =
          hubPid === undefined ? undefined : sessions.find((s) => s.pid === hubPid);
        if (hubPid !== undefined && hubSession !== undefined && feedsDirty) {
          const sourcePid =
            lowestPidByExe(sessions).get(hubSession.exe_name.toLowerCase()) ?? hubPid;
          // A staged input whose process has left cannot land; saying so beats a
          // press that quietly did nothing, and the rest of the plan goes
          // through. "Left" is both lists: a target the session list never held
          // may live in the windowed pool, and only leaving *that* is gone.
          const inPool = (target: number): boolean =>
            sessions.some((s) => s.pid === target) || windowApps.some((s) => s.pid === target);
          if (selectedFeedPids.some((target) => !inPool(target))) {
            get().raiseError(i18next.t('log.processGone'));
          }
          await Promise.allSettled([
            ...selectedFeedPids
              .filter((target) => !liveFeeds.includes(target) && inPool(target))
              .map((target) => get().addFeed(sourcePid, target)),
            ...liveFeeds
              .filter((target) => !selectedFeedPids.includes(target))
              .map((target) => get().removeFeed(sourcePid, target)),
          ]);
          // What landed is the plan now, and the staged list goes back to tracking
          // the live map — but only when all of it landed. A pair the backend
          // refused leaves the plan frozen exactly as staged, so the hub keeps
          // asking and the next press retries precisely what failed.
          const liveNow = feedTargetsOf(get(), hubPid);
          if (
            selectedFeedPids.every((target) => liveNow.includes(target)) &&
            liveNow.every((target) => selectedFeedPids.includes(target))
          ) {
            set({ feedSelectionPrefilled: true });
          }
        }
      } catch (e) {
        get().raiseError(i18next.t('log.routeFailed', { error: String(e) }), {
          detail: String(e),
        });
      } finally {
        // Always release the flighting flag — a failed route must not leave the
        // hub latched disabled against a still-routable selection.
        set({ applying: false });
      }
    },
  };
}
