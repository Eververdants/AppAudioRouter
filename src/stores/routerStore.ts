import { create } from 'zustand';
import i18next from 'i18next';
import type {
  AudioChangedEvent,
  AudioDevice,
  AudioSession,
  DuplicationStoppedEvent,
  LogEntry,
} from '@/lib/types';
import { currentLanguage } from '@/i18n';
import {
  DEFAULT_DELAY_RANGE_MS,
  DELAY_STEP_STORAGE_KEY,
  clampDelay,
  clampStep,
  rangeSeconds,
  readDelayStep,
} from '@/lib/delay';
import * as api from '@/lib/invoke';

interface RouterState {
  devices: AudioDevice[];
  sessions: AudioSession[];
  /** Processes targeted by the current selection (Ctrl+click to multi-select). */
  selectedPids: number[];
  /** Devices targeted by the current selection, in route order (first = primary). */
  selectedDeviceIds: string[];
  /** Devices each process is currently routed to, keyed by PID. */
  routedPids: Record<number, string[]>;
  /**
   * System default render device. It is the endpoint a process plays through
   * until it gets an explicit route, so selecting a process falls back to it.
   */
  defaultDeviceId: string | null;
  /** Per-device delay compensation in milliseconds (signed). */
  deviceDelays: Record<string, number>;
  /** Largest magnitude a delay may be set to, in milliseconds. */
  delayRangeMs: number;
  /** How much one −/+ click changes a delay, in milliseconds. A UI preference
   * (persisted to localStorage, like the theme), not an engine setting. */
  delayStepMs: number;
  /** Per-device volume in percent (100 = the level the app produced). */
  deviceVolumes: Record<string, number>;
  /** Whether delay compensation is applied by the engine. */
  delaySync: boolean;
  autoRemember: boolean;
  /** Whether the close button hides the window to the tray instead of quitting. */
  closeToTray: boolean;
  /** Whether Windows starts this app at sign-in. */
  autostart: boolean;
  logs: LogEntry[];
  loading: boolean;
  /** True while a route request is in flight, so a rapid double-click cannot
   * dispatch two overlapping routes against the same selection. */
  applying: boolean;

  // actions
  /** Pull the device list from the audio engine. `viaNotification` marks a refresh
   * the backend's change callbacks provoked: it only reaches the log when the list
   * really differs from what the UI already shows. */
  refreshDevices: (viaNotification?: boolean) => Promise<void>;
  /** Pull the process list, with the same logging rule as [`refreshDevices`]. */
  refreshSessions: (viaNotification?: boolean) => Promise<void>;
  /** Fold one Core Audio change notification into the UI: refresh whatever moved
   * and quietly, since the user did not ask for this. */
  syncFromNotification: (changed: AudioChangedEvent) => Promise<void>;
  loadDefaultDevice: () => Promise<void>;
  selectProcess: (pid: number) => void;
  toggleProcessSelection: (pid: number) => void;
  toggleDeviceSelection: (deviceId: string) => void;
  toggleAutoRemember: () => void;
  /** Read the close-to-tray preference and the startup registry entry. */
  loadShellSettings: () => Promise<void>;
  toggleCloseToTray: () => Promise<void>;
  toggleAutostart: () => Promise<void>;
  applyRoute: () => Promise<void>;
  stopRoute: (pid: number) => Promise<void>;
  stopAllRoutes: () => Promise<void>;
  loadDelaySettings: () => Promise<void>;
  loadDeviceVolumes: () => Promise<void>;
  setDeviceVolume: (deviceId: string, percent: number) => Promise<void>;
  setDeviceDelayValue: (deviceId: string, delayMs: number) => Promise<void>;
  setDelayRange: (rangeMs: number) => Promise<void>;
  setDelayStep: (stepMs: number) => void;
  toggleDelaySync: () => Promise<void>;
  handleDuplicationStopped: (event: DuplicationStoppedEvent) => void;
  /** On boot, ask the backend which PIDs it is still duplicating (routes
   *  survive a restart) and reconcile the UI so its badges match reality. */
  reconcileActiveDuplications: () => Promise<void>;
  addLog: (message: string, level?: LogEntry['level']) => void;
}

let logId = 0;

/** The system default device as a route target, when it is still present. */
function defaultTargets(state: Pick<RouterState, 'devices' | 'defaultDeviceId'>): string[] {
  const id = state.defaultDeviceId;
  return id !== null && state.devices.some((d) => d.id === id) ? [id] : [];
}

/**
 * Route order for a set of devices: earliest delay first.
 *
 * Delays are absolute — each device is measured against the app's audio — but
 * only the earliest device can stay where it is, because the OS plays the
 * primary one natively and software delay can only be added. Ordering the route
 * this way puts that earliest device first, so every other device really is
 * held back by exactly the difference the user configured.
 */
function orderByDelay(ids: string[], delays: Record<string, number>): string[] {
  return [...ids].sort((a, b) => (delays[a] ?? 0) - (delays[b] ?? 0));
}

/**
 * Identity of the device list, so a refresh that came from a Core Audio
 * notification can tell "the audio engine moved" apart from "what the screen
 * shows moved" — the first happens several times per hotplug, the second is the
 * only one worth a log line.
 */
function deviceSignature(devices: AudioDevice[]): string {
  return devices.map((d) => `${d.id}|${d.name}`).join('\n');
}

/** Same idea for the process list; a session's title is not part of its identity. */
function sessionSignature(sessions: AudioSession[]): string {
  return sessions.map((s) => `${s.pid}|${s.exe_name}`).join('\n');
}

export const useRouterStore = create<RouterState>((set, get) => ({
  devices: [],
  sessions: [],
  selectedPids: [],
  selectedDeviceIds: [],
  routedPids: {},
  defaultDeviceId: null,
  deviceDelays: {},
  delayRangeMs: DEFAULT_DELAY_RANGE_MS,
  delayStepMs: readDelayStep(),
  deviceVolumes: {},
  delaySync: false,
  autoRemember: false,
  closeToTray: false,
  autostart: false,
  logs: [],
  loading: false,
  applying: false,

  refreshDevices: async (viaNotification = false) => {
    try {
      const devices = await api.listDevices();
      const liveIds = new Set(devices.map((d) => d.id));
      const unchanged = deviceSignature(devices) === deviceSignature(get().devices);
      set({ devices });
      // A physically-routed device may have been unplugged. Drop it from the
      // selection and from any route that referenced it; a route left pointing
      // at a gone device is silently unroutable and confuses the badges.
      set((s) => {
        const selectedDeviceIds = s.selectedDeviceIds.filter((id) => liveIds.has(id));
        const routedPids: Record<number, string[]> = {};
        for (const [pid, ids] of Object.entries(s.routedPids)) {
          const remaining = ids.filter((id) => liveIds.has(id));
          if (remaining.length > 0) routedPids[Number(pid)] = remaining;
        }
        return { selectedDeviceIds, routedPids };
      });
      // Nothing on screen moved, so a notification gets no line at all.
      if (viaNotification && unchanged) return;
      get().addLog(
        viaNotification
          ? i18next.t('log.devicesChanged', { n: devices.length })
          : i18next.t('log.deviceRefreshed', { n: devices.length }),
        'info',
      );
    } catch (e) {
      get().addLog(i18next.t('log.deviceRefreshFailed', { error: String(e) }), 'error');
    }
  },

  refreshSessions: async (viaNotification = false) => {
    try {
      const sessions = await api.listSessions();
      const unchanged = sessionSignature(sessions) === sessionSignature(get().sessions);
      set({ sessions });
      if (viaNotification && unchanged) return;
      get().addLog(
        viaNotification
          ? i18next.t('log.sessionsChanged', { n: sessions.length })
          : i18next.t('log.sessionsRefreshed', { n: sessions.length }),
        'info',
      );
    } catch (e) {
      get().addLog(i18next.t('log.sessionsRefreshFailed', { error: String(e) }), 'error');
    }
  },

  syncFromNotification: async ({ devices, sessions }) => {
    if (devices) {
      // The system default is what an unrouted process falls back to, and it is
      // exactly what unplugging the current output tends to move.
      await get().refreshDevices(true);
      await get().loadDefaultDevice();
    }
    if (sessions) await get().refreshSessions(true);
  },

  loadDefaultDevice: async () => {
    try {
      const device = await api.getDefaultDevice();
      set({ defaultDeviceId: device.id });
    } catch (e) {
      get().addLog(i18next.t('log.defaultDeviceFailed', { error: String(e) }), 'error');
    }
  },

  selectProcess: (pid) =>
    set((s) => ({
      // Single selection starts fresh from that process's active targets, or
      // from the system default endpoint it already plays through.
      selectedPids: [pid],
      selectedDeviceIds: s.routedPids[pid] ?? defaultTargets(s),
    })),

  toggleProcessSelection: (pid) =>
    set((s) => {
      const selectedPids = s.selectedPids.includes(pid)
        ? s.selectedPids.filter((p) => p !== pid)
        : [...s.selectedPids, pid];
      // Device targets stay shared across a multi-selection; clear them only
      // when the last process was deselected.
      const selectedDeviceIds = selectedPids.length === 0 ? [] : s.selectedDeviceIds;
      return { selectedPids, selectedDeviceIds };
    }),

  toggleDeviceSelection: (deviceId) =>
    set((s) => {
      const index = s.selectedDeviceIds.indexOf(deviceId);
      const next =
        index >= 0
          ? s.selectedDeviceIds.filter((id) => id !== deviceId)
          : [...s.selectedDeviceIds, deviceId];
      return { selectedDeviceIds: next };
    }),

  toggleAutoRemember: () => set((s) => ({ autoRemember: !s.autoRemember })),

  loadShellSettings: async () => {
    // Both come from the native side: the close-to-tray preference sits with the
    // other backend settings, and the startup entry's source of truth is the
    // registry — Task Manager can delete it, and the switch has to show that.
    try {
      const [closeToTray, autostart] = await Promise.all([
        api.getCloseToTray(),
        api.getAutostart(),
      ]);
      set({ closeToTray, autostart });
    } catch (e) {
      get().addLog(i18next.t('log.shellSettingsFailed', { error: String(e) }), 'error');
    }
  },

  toggleCloseToTray: async () => {
    const next = !get().closeToTray;
    set({ closeToTray: next });
    try {
      await api.setCloseToTray(next);
      get().addLog(i18next.t(next ? 'log.closeToTrayOn' : 'log.closeToTrayOff'), 'info');
    } catch (e) {
      set({ closeToTray: !next });
      get().addLog(i18next.t('log.closeToTrayFailed', { error: String(e) }), 'error');
    }
  },

  toggleAutostart: async () => {
    const next = !get().autostart;
    set({ autostart: next });
    try {
      await api.setAutostart(next);
      get().addLog(i18next.t(next ? 'log.autostartOn' : 'log.autostartOff'), 'info');
    } catch (e) {
      // Writing HKCU\...\Run can genuinely fail; the switch must snap back rather
      // than lie about an entry that is not there.
      set({ autostart: !next });
      get().addLog(i18next.t('log.autostartFailed', { error: String(e) }), 'error');
    }
  },

  applyRoute: async () => {
    // A flighting request already owns the selection: a second click while the
    // first is in flight would dispatch a duplicate route against the same
    // targets. Let the first one land, then start from fresh state.
    if (get().applying) return;
    set({ applying: true });
    const { selectedPids, selectedDeviceIds, autoRemember, sessions } = get();
    if (selectedPids.length === 0 || selectedDeviceIds.length === 0) {
      set({ applying: false });
      get().addLog(i18next.t('log.selectProcessAndDevice'), 'error');
      return;
    }
    const targets = selectedPids.flatMap((pid) => {
      const session = sessions.find((s) => s.pid === pid);
      return session ? [{ pid, exeName: session.exe_name }] : [];
    });
    if (targets.length === 0) {
      set({ applying: false });
      get().addLog(i18next.t('log.processGone'), 'error');
      return;
    }
    const skipped = selectedPids.length - targets.length;
    if (skipped > 0) {
      get().addLog(i18next.t('log.someProcessesGone', { n: skipped }), 'info');
    }

    // Apply in delay order so the earliest device is the one the OS plays
    // natively; the selection is reordered along with it, which is what the
    // badges on the stage show.
    const ordered = orderByDelay(selectedDeviceIds, get().deviceDelays);
    const deviceNames = ordered.map((id) => get().devices.find((d) => d.id === id)?.name ?? id);
    const primary = deviceNames[0];
    const extra = ordered.length - 1;
    try {
      for (const target of targets) {
        await api.applyRoute(target.pid, target.exeName, ordered, autoRemember);
      }
      set((s) => ({
        routedPids: {
          ...s.routedPids,
          ...Object.fromEntries(targets.map((t) => [t.pid, [...ordered]])),
        },
        selectedDeviceIds: ordered,
      }));
      const count = targets.length;
      const key =
        count > 1
          ? autoRemember
            ? 'log.routedMultiProcessRemembered'
            : 'log.routedMultiProcess'
          : autoRemember
            ? 'log.routedRemembered'
            : 'log.routed';
      get().addLog(
        i18next.t(key, {
          n: count,
          process: targets[0]?.exeName ?? '',
          device: primary,
          m: extra,
        }),
        'success',
      );
    } catch (e) {
      get().addLog(i18next.t('log.routeFailed', { error: String(e) }), 'error');
    } finally {
      // Always release the flighting flag — a failed route must not leave the
      // hub latched disabled against a still-routable selection.
      set({ applying: false });
    }
  },

  stopRoute: async (pid) => {
    const session = get().sessions.find((s) => s.pid === pid);
    if (!get().routedPids[pid]) return;
    // Snapshot before mutating: if the backend rejects the stop the UI must
    // keep showing the route as live instead of silently desyncing from it.
    const previous = get().routedPids[pid];
    try {
      // Optimistic: reflect the stop immediately so the UI feels instant.
      set((s) => {
        const routedPids = { ...s.routedPids };
        delete routedPids[pid];
        const wasOnlySelection = s.selectedPids.length === 1 && s.selectedPids[0] === pid;
        return {
          routedPids,
          selectedPids: s.selectedPids.filter((p) => p !== pid),
          selectedDeviceIds: wasOnlySelection ? [] : s.selectedDeviceIds,
        };
      });
      await api.stopRoute(pid);
      get().addLog(
        i18next.t('log.routeStopped', { process: session?.exe_name ?? `PID ${pid}` }),
        'info',
      );
    } catch (e) {
      // Backend didn't actually stop: roll the route back into view.
      set((s) => ({ routedPids: { ...s.routedPids, [pid]: previous! } }));
      get().addLog(i18next.t('log.stopRouteFailed', { error: String(e) }), 'error');
    }
  },

  stopAllRoutes: async () => {
    const pids = Object.keys(get().routedPids).map(Number);
    if (pids.length === 0) return;
    // Optimistic: assume every stop succeeds, then put back the ones that
    // didn't. Failed stops must keep their route live rather than desyncing
    // the UI from an engine that is still duplicating.
    const snapshot = { ...get().routedPids };
    set({ routedPids: {} });
    const failed: number[] = [];
    for (const pid of pids) {
      try {
        await api.stopRoute(pid);
      } catch (e) {
        failed.push(pid);
        get().addLog(i18next.t('log.stopRouteFailed', { error: String(e) }), 'error');
      }
    }
    set((s) => {
      const routedPids: Record<number, string[]> = {};
      for (const pid of failed) routedPids[pid] = snapshot[pid] ?? [];
      const selectedPids = s.selectedPids.filter((p) => !pids.includes(p) || failed.includes(p));
      return {
        routedPids,
        selectedPids,
        selectedDeviceIds: selectedPids.length === 0 ? [] : s.selectedDeviceIds,
      };
    });
    get().addLog(
      i18next.t('log.stoppedAll', { n: pids.length - failed.length }),
      failed.length > 0 ? 'error' : 'info',
    );
  },

  loadDelaySettings: async () => {
    try {
      const [delays, delaySync, delayRangeMs] = await Promise.all([
        api.getDeviceDelays(),
        api.getDelaySync(),
        api.getDelayRange(),
      ]);
      const deviceDelays: Record<string, number> = {};
      for (const [deviceId, delayMs] of delays) {
        deviceDelays[deviceId] = delayMs;
      }
      set({ deviceDelays, delaySync, delayRangeMs });
    } catch (e) {
      get().addLog(i18next.t('log.delaySettingsFailed', { error: String(e) }), 'error');
    }
  },

  loadDeviceVolumes: async () => {
    try {
      const pairs = await api.getDeviceVolumes();
      const deviceVolumes: Record<string, number> = {};
      for (const [deviceId, percent] of pairs) {
        deviceVolumes[deviceId] = percent;
      }
      set({ deviceVolumes });
    } catch (e) {
      get().addLog(i18next.t('log.deviceVolumesFailed', { error: String(e) }), 'error');
    }
  },

  setDeviceVolume: async (deviceId, percent) => {
    const current = get().deviceVolumes[deviceId] ?? 100;
    if (current === percent) return;
    const device = get().devices.find((d) => d.id === deviceId);
    set((s) => {
      const deviceVolumes = { ...s.deviceVolumes };
      if (percent >= 100) {
        delete deviceVolumes[deviceId];
      } else {
        deviceVolumes[deviceId] = percent;
      }
      return { deviceVolumes };
    });
    try {
      await api.setDeviceVolume(deviceId, percent);
      get().addLog(
        i18next.t('log.deviceVolumeSet', { device: device?.name ?? deviceId, n: percent }),
        'info',
      );
    } catch (e) {
      // The backend rejected the value; undo the optimistic update so the UI
      // keeps matching what the engine actually applies and persists.
      set((s) => {
        const deviceVolumes = { ...s.deviceVolumes };
        if (current >= 100) {
          delete deviceVolumes[deviceId];
        } else {
          deviceVolumes[deviceId] = current;
        }
        return { deviceVolumes };
      });
      get().addLog(i18next.t('log.deviceVolumeFailed', { error: String(e) }), 'error');
    }
  },

  setDeviceDelayValue: async (deviceId, delayMs) => {
    const current = get().deviceDelays[deviceId] ?? 0;
    const next = clampDelay(delayMs, get().delayRangeMs);
    if (current === next) return;
    const device = get().devices.find((d) => d.id === deviceId);
    set((s) => ({ deviceDelays: { ...s.deviceDelays, [deviceId]: next } }));
    try {
      await api.setDeviceDelay(deviceId, next);
      get().addLog(
        i18next.t('log.delaySet', { device: device?.name ?? deviceId, n: next }),
        'info',
      );
    } catch (e) {
      // The backend rejected the value; undo the optimistic update so the UI
      // keeps matching what the engine actually applies and persists.
      set((s) => {
        const deviceDelays = { ...s.deviceDelays };
        if (current === 0) {
          delete deviceDelays[deviceId];
        } else {
          deviceDelays[deviceId] = current;
        }
        return { deviceDelays };
      });
      get().addLog(i18next.t('log.delaySetFailed', { error: String(e) }), 'error');
    }
  },

  setDelayRange: async (rangeMs) => {
    const { delayRangeMs: previousRange, deviceDelays: previousDelays } = get();
    if (previousRange === rangeMs) return;
    // Lowering the range pulls the affected values down with it, matching what
    // the backend does when it persists the new bound.
    set((s) => {
      const deviceDelays: Record<string, number> = {};
      for (const [deviceId, delayMs] of Object.entries(s.deviceDelays)) {
        const clamped = clampDelay(delayMs, rangeMs);
        if (clamped !== 0) deviceDelays[deviceId] = clamped;
      }
      return { delayRangeMs: rangeMs, deviceDelays };
    });
    try {
      await api.setDelayRange(rangeMs);
      get().addLog(i18next.t('log.delayRangeSet', { n: rangeSeconds(rangeMs) }), 'info');
    } catch (e) {
      set({ delayRangeMs: previousRange, deviceDelays: previousDelays });
      get().addLog(i18next.t('log.delayRangeSetFailed', { error: String(e) }), 'error');
    }
  },

  setDelayStep: (stepMs) => {
    const step = clampStep(stepMs);
    if (get().delayStepMs === step) return;
    set({ delayStepMs: step });
    try {
      localStorage.setItem(DELAY_STEP_STORAGE_KEY, String(step));
    } catch {
      /* storage may be unavailable; the preference just does not persist */
    }
  },

  toggleDelaySync: async () => {
    const next = !get().delaySync;
    set({ delaySync: next });
    try {
      await api.setDelaySync(next);
      get().addLog(i18next.t(next ? 'log.delaySyncOn' : 'log.delaySyncOff'), 'info');
    } catch (e) {
      set({ delaySync: !next });
      get().addLog(i18next.t('log.delaySyncFailed', { error: String(e) }), 'error');
    }
  },

  handleDuplicationStopped: (event) => {
    const { pid, reason, error } = event;
    // `stopped` is the ack of an explicit stop or re-route, both of which
    // already updated routedPids synchronously — the event may arrive after a
    // newer route was applied, so it must not clear state here.
    if (reason === 'stopped') return;
    set((s) => {
      const routedPids = { ...s.routedPids };
      delete routedPids[pid];
      const selectedPids = s.selectedPids.filter((p) => p !== pid);
      const wasSelected = s.selectedPids.includes(pid);
      return {
        routedPids,
        selectedPids,
        selectedDeviceIds: wasSelected && selectedPids.length === 0 ? [] : s.selectedDeviceIds,
      };
    });
    if (reason === 'error') {
      get().addLog(i18next.t('log.duplicationFailed', { pid, error: error ?? '' }), 'error');
    } else {
      get().addLog(i18next.t('log.duplicationProcessExited', { pid }), 'info');
    }
  },

  reconcileActiveDuplications: async () => {
    // Routes are persisted by the audio service and a duplication engine can
    // outlive this process (it dies only when the target process exits or the
    // user stops it). On boot the frontend would otherwise believe nothing is
    // routed, so ask the backend what it is still duplicating and mark those
    // PIDs live. The device list is not reported back, so a reconciled route
    // shows as active without its device badges until the user re-routes.
    try {
      const active = await api.getActiveDuplications();
      const live = new Set(active);
      if (live.size === 0) return;
      set((s) => {
        const routedPids: Record<number, string[]> = {};
        for (const pid of live) {
          routedPids[pid] = s.routedPids[pid] ?? [];
        }
        return { routedPids };
      });
    } catch {
      /* enumerating active engines is best-effort; the user can re-route */
    }
  },

  addLog: (message, level = 'info') => {
    const ts = new Date().toLocaleTimeString(currentLanguage(), { hour12: false });
    set((s) => ({
      logs: [...s.logs, { id: ++logId, timestamp: ts, message, level }].slice(-200),
    }));
  },
}));
