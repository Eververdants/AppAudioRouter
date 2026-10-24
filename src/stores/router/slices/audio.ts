import i18next from 'i18next';
import * as api from '@/lib/invoke';
import {
  deviceRefreshGate,
  queueAssignmentWork,
  queueRefresh,
  runQueuedRefresh,
  sessionRefreshGate,
} from '../gates';
import { deriveFeeds, foldSounding } from '../pure/processes';
import { compareSessions, deviceSignature, sessionSignature } from '../pure/signatures';
import type { AudioActions, GetRouterState, SetRouterState } from '../types';

/** The two enumerations, the system default, the capture endpoints and the
 *  windowed-app pool — plus the notification fold that decides which of them
 *  to re-read. Every one of these is a background read: the failure channel is
 *  the log, and only a press against a list already on screen is the user's own
 *  ask (see `refreshDevices` for the rule in full). */
export function createAudioSlice(set: SetRouterState, get: GetRouterState): AudioActions {
  return {
    refreshDevices: async (viaNotification = false) => {
      if (deviceRefreshGate.inFlight) {
        queueRefresh(deviceRefreshGate, viaNotification);
        return;
      }
      deviceRefreshGate.inFlight = true;
      try {
        const devices = await api.listDevices();
        const liveIds = new Set(devices.map((d) => d.id));
        const unchanged = deviceSignature(devices) === deviceSignature(get().devices);
        // One commit, not two: the new list and what it implies for the routes
        // arrive together. Published apart, there is a render in which the
        // devices are the new ones while a route still names one that is gone —
        // an unroutable badge, drawn for no longer than it takes to notice.
        //
        // A physically-routed device may have been unplugged. Drop it from the
        // selection and from any route that referenced it; a route left pointing
        // at a gone device is silently unroutable and confuses the badges.
        //
        // A route whose *every* target vanished also ends here. A multi-device
        // route's engine notices and stops itself through `reconcile`; a
        // single-device route has no engine, so nothing else would release its
        // per-app assignment — one left booked as a live route is skipped by the
        // settings reset, skipped by the stale sweep while the program lives, and
        // keeps outranking the system default with nothing on the board to stop.
        // Released directly rather than through the stop action, so the unplug
        // does not erase the memory a returning device should restore from.
        const enginelessEnded: number[] = [];
        if (devices.length > 0) {
          const generations = get().engineGenerations;
          for (const [pid, ids] of Object.entries(get().routedPids)) {
            if (ids.every((id) => !liveIds.has(id)) && (generations[Number(pid)] ?? 0) === 0) {
              enginelessEnded.push(Number(pid));
            }
          }
        }
        set((s) => {
          const selectedDeviceIds = s.selectedDeviceIds.filter((id) => liveIds.has(id));
          const routedPids: Record<number, string[]> = {};
          const engineGenerations = { ...s.engineGenerations };
          for (const [pid, ids] of Object.entries(s.routedPids)) {
            const numericPid = Number(pid);
            const remaining = ids.filter((id) => liveIds.has(id));
            if (remaining.length > 0) routedPids[numericPid] = remaining;
            else delete engineGenerations[numericPid];
          }
          return { devices, selectedDeviceIds, routedPids, engineGenerations, devicesError: null };
        });
        for (const pid of enginelessEnded) {
          api.stopRoute(pid).catch(() => {
            /* best effort — a failed release leaves the pin for a later path */
          });
        }
        // The device list is one of the three inputs a restore needs, and at boot
        // it is just as likely to be the last of them to arrive.
        queueAssignmentWork(() => get().restoreRememberedRoutes());
        // Nothing on screen moved, so a notification gets no line at all.
        if (viaNotification && unchanged) return;
        get().addLog(
          viaNotification
            ? i18next.t('log.devicesChanged', { n: devices.length })
            : i18next.t('log.deviceRefreshed', { n: devices.length }),
          'info',
        );
      } catch (e) {
        const message = i18next.t('log.deviceRefreshFailed', { error: String(e) });
        // The channel follows who asked for the read, not what caused it. Unplugging
        // a device is something the user did, but nobody asked for this list — and the
        // enumeration that runs before any device list exists is the app asking on its
        // own, which is one of the three boot inputs whose arrival order nobody
        // caused. Only a press against a list already on screen is a thing the user
        // tried and did not get, and that one answers where they are looking.
        set({ devicesError: message });
        if (viaNotification || get().devices.length === 0) get().addLog(message, 'error');
        else get().raiseError(message);
      } finally {
        deviceRefreshGate.inFlight = false;
        runQueuedRefresh(deviceRefreshGate, (rerunViaNotification) => {
          void get().refreshDevices(rerunViaNotification);
        });
      }
    },

    refreshSessions: async (viaNotification = false) => {
      if (sessionRefreshGate.inFlight) {
        queueRefresh(sessionRefreshGate, viaNotification);
        return;
      }
      sessionRefreshGate.inFlight = true;
      set({ sessionsRefreshing: true });
      // Whether a list is already on screen: the same seam the device refresh reads.
      const listWasUp = get().sessionsLoaded;
      try {
        const sessions = (await api.listSessions()).sort(compareSessions);
        const livePids = new Set(sessions.map((s) => s.pid));
        const unchanged = sessionSignature(sessions) === sessionSignature(get().sessions);
        const routedBefore = Object.keys(get().routedPids).map(Number);
        set((s) => {
          // A single-device route has no duplication engine to report its end, so
          // the session list is the authoritative signal that its PID is gone.
          const routedPids: Record<number, string[]> = {};
          // A route is the program's but held by one of its processes: when the
          // holder died the route died with it, and the program's surviving
          // siblings carry a plan for a route nothing runs any more. They leave
          // the selection with it — the same rule a manual stop follows. The
          // executable is read from the *outgoing* list; the new one no longer
          // names a process that has left.
          const endedRouteExes = new Set<string>();
          for (const [pid, ids] of Object.entries(s.routedPids)) {
            const numericPid = Number(pid);
            if (livePids.has(numericPid)) {
              routedPids[numericPid] = ids;
            } else {
              const exe = s.sessions.find((x) => x.pid === numericPid)?.exe_name.toLowerCase();
              if (exe !== undefined) endedRouteExes.add(exe);
            }
          }
          const selectedPids = s.selectedPids.filter((pid) => {
            if (!livePids.has(pid)) return false;
            const exe = sessions.find((x) => x.pid === pid)?.exe_name.toLowerCase();
            return exe === undefined || !endedRouteExes.has(exe);
          });
          const engineGenerations: Record<number, number> = {};
          for (const [pid, generation] of Object.entries(s.engineGenerations)) {
            const numericPid = Number(pid);
            if (livePids.has(numericPid)) engineGenerations[numericPid] = generation;
          }
          // Rebuilt rather than merged: the list is the authority on who is
          // sounding, so a process that left it stops sounding even if its
          // Inactive transition was never observed. The session-activity events
          // keep this current between refreshes, the moment a session flips.
          const soundingPids: Record<number, boolean> = {};
          for (const session of sessions) {
            if (session.playing === true) soundingPids[session.pid] = true;
          }
          const soundingExes = foldSounding(sessions, soundingPids);
          // Feeds pin an endpoint on each end, so the source has to hold a
          // session and the target has to be a live process — rebuilt from the
          // memory, same as the badges above are rebuilt from the engine list.
          const feeds = deriveFeeds(s.rememberedFeeds, sessions, s.windowApps);
          return {
            sessions,
            routedPids,
            selectedPids,
            selectedDeviceIds: selectedPids.length === 0 ? [] : s.selectedDeviceIds,
            engineGenerations,
            soundingPids,
            soundingExes,
            feeds,
            sessionsError: null,
          };
        });
        // A routed program can exit on its own, and the fixed output device
        // Windows took then outlives it: the next launch would play to the old
        // device and ignore the system default, with no route on screen to explain
        // it. Ask the backend to hand that assignment to the program's next
        // process instead of leaving it behind.
        //
        // The sweep and the two restores below are ordered rather than concurrent:
        // all three can touch the same executable's assignment — the sweep through
        // the program's new process, the restores by writing one — and run together
        // the sweep can win and undo a route that was just applied. Queuing them
        // together makes that ordering hold at every entry point, not just this one.
        if (routedBefore.some((pid) => !livePids.has(pid))) {
          queueAssignmentWork(() => get().releaseStaleRoutes());
        }
        // A program that has just started playing is the moment its remembered
        // route is due; the same pass picks up everything that was already running
        // when the app launched. Feeds ride the same ordering — both passes can
        // pin endpoints around one executable.
        queueAssignmentWork(() => get().restoreRememberedRoutes());
        queueAssignmentWork(() => get().restoreRememberedFeeds());
        // Icons ride behind the list, never in front of it: the rows are already
        // on screen with their letter tiles by the time the shell answers.
        get().loadMissingIcons();
        if (viaNotification && unchanged) return;
        get().addLog(
          viaNotification
            ? i18next.t('log.sessionsChanged', { n: sessions.length })
            : i18next.t('log.sessionsRefreshed', { n: sessions.length }),
          'info',
        );
      } catch (e) {
        const message = i18next.t('log.sessionsRefreshFailed', { error: String(e) });
        // The rule the device refresh states in full: a read the notification
        // provoked, and the app's own first read before anything is on screen, are
        // background reads and reach the log alone. The rail's Refresh button pressed
        // against a list that is already there is the user's own ask, and its refusal
        // has to stand where the user is looking.
        set({ sessionsError: message });
        if (viaNotification || !listWasUp) get().addLog(message, 'error');
        else get().raiseError(message);
      } finally {
        // Raised whether the enumeration answered or refused: after a failure the
        // rail would otherwise sit on "reading" forever, which is a different
        // lie and a worse one — nothing is coming to change it.
        set({ sessionsLoaded: true, sessionsRefreshing: false });
        sessionRefreshGate.inFlight = false;
        runQueuedRefresh(sessionRefreshGate, (rerunViaNotification) => {
          void get().refreshSessions(rerunViaNotification);
        });
      }
    },

    syncFromNotification: async ({ devices, sessions }) => {
      if (devices) {
        // The system default is what an unrouted process falls back to, and it is
        // exactly what unplugging the current output tends to move.
        await get().refreshDevices(true);
        // The carrier picker lists the capture flow too: a loopback driver
        // installed a minute ago must show up here without an app restart, or
        // the settings page cannot pair it right after the install.
        await get().loadCaptureDevices();
        await get().loadDefaultDevice();
      }
      if (sessions) await get().refreshSessions(true);
      // Anything the lists just noticed can change which engines are running and
      // therefore what their devices are playing at, and this is the refresh the
      // latency reading would otherwise never get: it is not tied to a route
      // action, and nothing else asks the engines again.
      await get().reconcileActiveDuplications();
    },

    loadDefaultDevice: async () => {
      try {
        const device = await api.getDefaultDevice();
        set({ defaultDeviceId: device.id });
      } catch (e) {
        get().addLog(i18next.t('log.defaultDeviceFailed', { error: String(e) }), 'error');
      }
    },

    loadCaptureDevices: async () => {
      try {
        set({ captureDevices: await api.listCaptureDevices() });
      } catch (e) {
        get().addLog(i18next.t('log.captureDevicesFailed', { error: String(e) }), 'error');
      }
    },

    loadWindowApps: async () => {
      try {
        set({ windowApps: await api.listWindowApps() });
      } catch (e) {
        get().addLog(i18next.t('log.windowAppsFailed', { error: String(e) }), 'error');
        return;
      }
      // The pool arriving is the moment every remembered feed whose target runs
      // silently becomes displayable: the live map is rebuilt with it, and the
      // restore is asked the way every other arriving input asks — whichever of
      // the three inputs landed last is the one that can actually pin.
      set((s) => ({ feeds: deriveFeeds(s.rememberedFeeds, s.sessions, s.windowApps) }));
      queueAssignmentWork(() => get().restoreRememberedFeeds());
      // The picker names these apps, so they carry icons like the session list
      // does; the ask reuses the same one-per-exe in-flight guard and retry
      // budget, and a miss degrades to the letter tile as everywhere else.
      get().loadMissingIcons();
    },
  };
}
