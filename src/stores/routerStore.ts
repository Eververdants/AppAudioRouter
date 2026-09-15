import { create } from 'zustand';
import i18next from 'i18next';
import type { AudioDevice, AudioSession, DuplicationStoppedEvent, LogEntry } from '@/lib/types';
import { currentLanguage } from '@/i18n';
import { DEFAULT_DELAY_RANGE_MS, clampDelay, rangeSeconds } from '@/lib/delay';
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
  /** Per-device delay compensation in milliseconds (signed). */
  deviceDelays: Record<string, number>;
  /** Largest magnitude a delay may be set to, in milliseconds. */
  delayRangeMs: number;
  /** Per-exe volume limits in percent (100 = no limit). */
  volumeLimits: Record<string, number>;
  /** Whether delay compensation is applied by the engine. */
  delaySync: boolean;
  autoRemember: boolean;
  logs: LogEntry[];
  loading: boolean;

  // actions
  refreshDevices: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  selectProcess: (pid: number) => void;
  toggleProcessSelection: (pid: number) => void;
  toggleDeviceSelection: (deviceId: string) => void;
  toggleAutoRemember: () => void;
  applyRoute: () => Promise<void>;
  stopRoute: (pid: number) => Promise<void>;
  stopAllRoutes: () => Promise<void>;
  loadDelaySettings: () => Promise<void>;
  loadVolumeLimits: () => Promise<void>;
  setVolumeLimit: (exeName: string, percent: number) => Promise<void>;
  setDeviceDelayValue: (deviceId: string, delayMs: number) => Promise<void>;
  setDelayRange: (rangeMs: number) => Promise<void>;
  toggleDelaySync: () => Promise<void>;
  handleDuplicationStopped: (event: DuplicationStoppedEvent) => void;
  addLog: (message: string, level?: LogEntry['level']) => void;
}

let logId = 0;

export const useRouterStore = create<RouterState>((set, get) => ({
  devices: [],
  sessions: [],
  selectedPids: [],
  selectedDeviceIds: [],
  routedPids: {},
  deviceDelays: {},
  delayRangeMs: DEFAULT_DELAY_RANGE_MS,
  volumeLimits: {},
  delaySync: false,
  autoRemember: false,
  logs: [],
  loading: false,

  refreshDevices: async () => {
    try {
      const devices = await api.listDevices();
      set({ devices });
      get().addLog(i18next.t('log.deviceRefreshed', { n: devices.length }), 'info');
    } catch (e) {
      get().addLog(i18next.t('log.deviceRefreshFailed', { error: String(e) }), 'error');
    }
  },

  refreshSessions: async () => {
    try {
      const sessions = await api.listSessions();
      set({ sessions });
      get().addLog(i18next.t('log.sessionsRefreshed', { n: sessions.length }), 'info');
    } catch (e) {
      get().addLog(i18next.t('log.sessionsRefreshFailed', { error: String(e) }), 'error');
    }
  },

  selectProcess: (pid) =>
    set((s) => ({
      // Single selection starts fresh from that process's active targets.
      selectedPids: [pid],
      selectedDeviceIds: s.routedPids[pid] ?? [],
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

  applyRoute: async () => {
    const { selectedPids, selectedDeviceIds, autoRemember, sessions } = get();
    if (selectedPids.length === 0 || selectedDeviceIds.length === 0) {
      get().addLog(i18next.t('log.selectProcessAndDevice'), 'error');
      return;
    }
    const targets = selectedPids.flatMap((pid) => {
      const session = sessions.find((s) => s.pid === pid);
      return session ? [{ pid, exeName: session.exe_name }] : [];
    });
    if (targets.length === 0) {
      get().addLog(i18next.t('log.processGone'), 'error');
      return;
    }
    const skipped = selectedPids.length - targets.length;
    if (skipped > 0) {
      get().addLog(i18next.t('log.someProcessesGone', { n: skipped }), 'info');
    }

    const deviceNames = selectedDeviceIds.map(
      (id) => get().devices.find((d) => d.id === id)?.name ?? id,
    );
    const primary = deviceNames[0];
    const extra = selectedDeviceIds.length - 1;
    try {
      for (const target of targets) {
        await api.applyRoute(target.pid, target.exeName, selectedDeviceIds, autoRemember);
      }
      set((s) => ({
        routedPids: {
          ...s.routedPids,
          ...Object.fromEntries(targets.map((t) => [t.pid, [...selectedDeviceIds]])),
        },
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
    }
  },

  stopRoute: async (pid) => {
    const session = get().sessions.find((s) => s.pid === pid);
    try {
      await api.stopRoute(pid);
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
      get().addLog(
        i18next.t('log.routeStopped', { process: session?.exe_name ?? `PID ${pid}` }),
        'info',
      );
    } catch (e) {
      get().addLog(i18next.t('log.stopRouteFailed', { error: String(e) }), 'error');
    }
  },

  stopAllRoutes: async () => {
    const pids = Object.keys(get().routedPids).map(Number);
    if (pids.length === 0) return;
    for (const pid of pids) {
      try {
        await api.stopRoute(pid);
      } catch (e) {
        get().addLog(i18next.t('log.stopRouteFailed', { error: String(e) }), 'error');
      }
    }
    const count = pids.length;
    set((s) => {
      const selectedPids = s.selectedPids.filter((p) => !pids.includes(p));
      return {
        routedPids: {},
        selectedPids,
        selectedDeviceIds: selectedPids.length === 0 ? [] : s.selectedDeviceIds,
      };
    });
    get().addLog(i18next.t('log.stoppedAll', { n: count }), 'info');
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

  loadVolumeLimits: async () => {
    try {
      const limits = await api.getVolumeLimits();
      const volumeLimits: Record<string, number> = {};
      for (const [exeName, percent] of limits) {
        volumeLimits[exeName] = percent;
      }
      set({ volumeLimits });
    } catch (e) {
      get().addLog(i18next.t('log.volumeLimitsFailed', { error: String(e) }), 'error');
    }
  },

  setVolumeLimit: async (exeName, percent) => {
    const current = get().volumeLimits[exeName] ?? 100;
    if (current === percent) return;
    set((s) => ({ volumeLimits: { ...s.volumeLimits, [exeName]: percent } }));
    // Apply to every live session of this executable (an app can own several).
    const targets = get().sessions.filter((s) => s.exe_name === exeName);
    try {
      for (const session of targets) {
        await api.setSessionVolume(session.pid, exeName, percent);
      }
      get().addLog(i18next.t('log.volumeSet', { exe: exeName, n: percent }), 'info');
    } catch (e) {
      // Roll back so the UI keeps matching what the engine applies and persists.
      set((s) => {
        const volumeLimits = { ...s.volumeLimits };
        if (current >= 100) {
          delete volumeLimits[exeName];
        } else {
          volumeLimits[exeName] = current;
        }
        return { volumeLimits };
      });
      get().addLog(i18next.t('log.volumeSetFailed', { error: String(e) }), 'error');
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
      get().addLog(i18next.t('log.delaySet', { device: device?.name ?? deviceId, n: next }), 'info');
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

  addLog: (message, level = 'info') => {
    const ts = new Date().toLocaleTimeString(currentLanguage(), { hour12: false });
    set((s) => ({
      logs: [...s.logs, { id: ++logId, timestamp: ts, message, level }].slice(-200),
    }));
  },
}));
