import i18next from 'i18next';
import * as api from '@/lib/invoke';
import { beginErrorBatch, endErrorBatch } from '../gates';
import { deviceName } from '../pure/targets';
import type { GetRouterState, RouteResetActions, SetRouterState } from '../types';

/** The two releases that are not a stop of one route: the settings page's reset
 *  of every per-app assignment no live route of ours holds — which cannot tell
 *  apart what this app wrote and what the user set in the volume mixer — and the
 *  boot sweep for programs that exited while routed. */
export function createResetSlice(set: SetRouterState, get: GetRouterState): RouteResetActions {
  return {
    resetPinnedEndpoints: async () => {
      try {
        const outcome = await api.resetPinnedEndpoints();
        get().addLog(i18next.t('log.pinnedEndpointsReset', { n: outcome.released }), 'info');
        if (outcome.still_pinned.length > 0) {
          // The service says which endpoint each program stays fixed to, or that
          // it would not answer at all: a user reading this has to be able to
          // tell "still booked on the TV" from "nothing could be read".
          const devices = get().devices;
          const named = outcome.still_pinned.map((exeName, index) => {
            const device = outcome.still_pinned_devices[index];
            if (device === undefined || device === null) {
              return i18next.t('log.pinnedEndpointsRemainingNoDevice', { process: exeName });
            }
            return i18next.t('log.pinnedEndpointsRemainingOnDevice', {
              process: exeName,
              device: deviceName(device, devices),
            });
          });
          get().addLog(
            i18next.t('log.pinnedEndpointsRemaining', { processes: named.join(', ') }),
            'error',
          );
        }
        return outcome;
      } catch (e) {
        get().raiseError(i18next.t('log.pinnedEndpointsResetFailed', { error: String(e) }), {
          detail: String(e),
        });
        return null;
      }
    },

    startClean: async () => {
      // Everything the restore already put up came from the memory about to be
      // forgotten, so it goes down the way the user would take it down: a stop
      // releases its assignment, a feed disconnects its pair. Only then the
      // files go — all of them in one backend call, so a half-done wipe can
      // never be mistaken for a clean slate.
      //
      // One user action, one card: every refused stop and every stuck wire still
      // writes its own error log the moment it happens, but the notice says them
      // together when the wipe ends — including when the wipe ends by throwing.
      beginErrorBatch();
      try {
        await get().stopAllRoutes();
        for (const [sourcePid, targets] of Object.entries(get().feeds)) {
          for (const targetPid of targets) {
            await get().removeFeed(Number(sourcePid), targetPid);
          }
        }
        try {
          await api.forgetPreviousSettings();
        } catch (e) {
          get().addLog(i18next.t('log.forgetPreviousFailed', { error: String(e) }), 'error');
          // Refuse out loud. A wipe that half happened and was reported as done
          // leaves the user on a machine they believe is clean, with no door left
          // to try again — the tour is gone for this version.
          throw e;
        }
        await Promise.all([
          get().loadRememberedRoutes(),
          get().loadFeeds(),
          get().loadDelaySettings(),
          get().loadDeviceVolumes(),
          get().loadSourceVolumes(),
        ]);
        get().addLog(i18next.t('log.forgetPrevious'), 'info');
      } finally {
        endErrorBatch(set);
      }
    },

    releaseStaleRoutes: async () => {
      try {
        const released = await api.releaseStaleRoutes();
        if (released.length > 0) {
          get().addLog(
            i18next.t('log.staleAssignmentReleased', { processes: released.join(', ') }),
            'info',
          );
        }
      } catch {
        /* best effort: the sweep runs again after the next session refresh */
      }
    },
  };
}
