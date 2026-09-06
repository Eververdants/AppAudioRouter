import { create } from 'zustand';
import i18next from 'i18next';
import type { AudioDevice, AudioSession, LogEntry } from '@/lib/types';
import { currentLanguage } from '@/i18n';
import * as api from '@/lib/invoke';

interface RouterState {
  devices: AudioDevice[];
  sessions: AudioSession[];
  selectedPid: number | null;
  selectedDeviceId: string | null;
  role: string;
  autoRemember: boolean;
  logs: LogEntry[];
  loading: boolean;

  // actions
  refreshDevices: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  selectProcess: (pid: number | null) => void;
  selectDevice: (deviceId: string | null) => void;
  setRole: (role: string) => void;
  toggleAutoRemember: () => void;
  applyRoute: () => Promise<void>;
  addLog: (message: string, level?: LogEntry['level']) => void;
}

let logId = 0;

export const useRouterStore = create<RouterState>((set, get) => ({
  devices: [],
  sessions: [],
  selectedPid: null,
  selectedDeviceId: null,
  role: 'all',
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

  selectProcess: (pid) => set({ selectedPid: pid }),
  selectDevice: (deviceId) => set({ selectedDeviceId: deviceId }),
  setRole: (role) => set({ role }),
  toggleAutoRemember: () => set((s) => ({ autoRemember: !s.autoRemember })),

  applyRoute: async () => {
    const { selectedPid, selectedDeviceId, role, autoRemember, sessions } = get();
    if (!selectedPid || !selectedDeviceId) {
      get().addLog(i18next.t('log.selectProcessAndDevice'), 'error');
      return;
    }
    const session = sessions.find((s) => s.pid === selectedPid);
    if (!session) {
      get().addLog(i18next.t('log.processGone'), 'error');
      return;
    }
    const device = get().devices.find((d) => d.id === selectedDeviceId);
    const deviceName = device?.name ?? selectedDeviceId;
    try {
      if (autoRemember) {
        await api.setRouteRemember(selectedDeviceId, selectedPid, role, session.exe_name);
        get().addLog(
          i18next.t('log.routedRemembered', { process: session.exe_name, device: deviceName }),
          'success',
        );
      } else {
        await api.setRoute(selectedDeviceId, selectedPid, role);
        get().addLog(
          i18next.t('log.routed', { process: session.exe_name, device: deviceName }),
          'success',
        );
      }
    } catch (e) {
      get().addLog(i18next.t('log.routeFailed', { error: String(e) }), 'error');
    }
  },

  addLog: (message, level = 'info') => {
    const ts = new Date().toLocaleTimeString(currentLanguage(), { hour12: false });
    set((s) => ({
      logs: [...s.logs, { id: ++logId, timestamp: ts, message, level }].slice(-200),
    }));
  },
}));
