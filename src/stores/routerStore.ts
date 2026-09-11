import { create } from 'zustand';
import i18next from 'i18next';
import type { AudioDevice, AudioSession, DuplicationStoppedEvent, LogEntry } from '@/lib/types';
import { currentLanguage } from '@/i18n';
import * as api from '@/lib/invoke';

interface RouterState {
  devices: AudioDevice[];
  sessions: AudioSession[];
  selectedPid: number | null;
  /** Devices targeted by the current selection, in route order (first = primary). */
  selectedDeviceIds: string[];
  /** Devices each process is currently routed to, keyed by PID. */
  routedPids: Record<number, string[]>;
  autoRemember: boolean;
  logs: LogEntry[];
  loading: boolean;

  // actions
  refreshDevices: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  selectProcess: (pid: number | null) => void;
  toggleDeviceSelection: (deviceId: string) => void;
  toggleAutoRemember: () => void;
  applyRoute: () => Promise<void>;
  stopRoute: (pid: number) => Promise<void>;
  handleDuplicationStopped: (event: DuplicationStoppedEvent) => void;
  addLog: (message: string, level?: LogEntry['level']) => void;
}

let logId = 0;

export const useRouterStore = create<RouterState>((set, get) => ({
  devices: [],
  sessions: [],
  selectedPid: null,
  selectedDeviceIds: [],
  routedPids: {},
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
      selectedPid: pid,
      // Show the process's active targets so re-routing starts from them.
      selectedDeviceIds: (pid && s.routedPids[pid]) || [],
    })),

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
    const { selectedPid, selectedDeviceIds, autoRemember, sessions } = get();
    if (!selectedPid || selectedDeviceIds.length === 0) {
      get().addLog(i18next.t('log.selectProcessAndDevice'), 'error');
      return;
    }
    const session = sessions.find((s) => s.pid === selectedPid);
    if (!session) {
      get().addLog(i18next.t('log.processGone'), 'error');
      return;
    }
    const deviceNames = selectedDeviceIds.map(
      (id) => get().devices.find((d) => d.id === id)?.name ?? id,
    );
    const primary = deviceNames[0];
    const extra = deviceNames.length - 1;
    try {
      await api.applyRoute(selectedPid, session.exe_name, selectedDeviceIds, autoRemember);
      set((s) => ({ routedPids: { ...s.routedPids, [selectedPid]: [...selectedDeviceIds] } }));
      const key =
        extra > 0
          ? autoRemember
            ? 'log.routedMultiRemembered'
            : 'log.routedMulti'
          : autoRemember
            ? 'log.routedRemembered'
            : 'log.routed';
      get().addLog(
        i18next.t(key, { process: session.exe_name, device: primary, n: extra }),
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
        return {
          routedPids,
          selectedDeviceIds: s.selectedPid === pid ? [] : s.selectedDeviceIds,
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

  handleDuplicationStopped: (event) => {
    const { pid, reason, error } = event;
    // `stopped` is the ack of an explicit stop or re-route, both of which
    // already updated routedPids synchronously — the event may arrive after a
    // newer route was applied, so it must not clear state here.
    if (reason === 'stopped') return;
    set((s) => {
      const routedPids = { ...s.routedPids };
      delete routedPids[pid];
      return {
        routedPids,
        selectedDeviceIds: s.selectedPid === pid ? [] : s.selectedDeviceIds,
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
