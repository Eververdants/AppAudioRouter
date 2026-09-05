import { create } from 'zustand';
import type { AudioDevice, AudioSession, LogEntry } from '@/lib/types';
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
      get().addLog(`设备列表已刷新 (${devices.length} 项)`, 'info');
    } catch (e) {
      get().addLog(`设备刷新失败: ${e}`, 'error');
    }
  },

  refreshSessions: async () => {
    try {
      const sessions = await api.listSessions();
      set({ sessions });
      get().addLog(`进程列表已刷新 (${sessions.length} 项)`, 'info');
    } catch (e) {
      get().addLog(`进程刷新失败: ${e}`, 'error');
    }
  },

  selectProcess: (pid) => set({ selectedPid: pid }),
  selectDevice: (deviceId) => set({ selectedDeviceId: deviceId }),
  setRole: (role) => set({ role }),
  toggleAutoRemember: () => set((s) => ({ autoRemember: !s.autoRemember })),

  applyRoute: async () => {
    const { selectedPid, selectedDeviceId, role, autoRemember, sessions } = get();
    if (!selectedPid || !selectedDeviceId) {
      get().addLog('请选择进程和设备', 'error');
      return;
    }
    const session = sessions.find((s) => s.pid === selectedPid);
    if (!session) {
      get().addLog('所选进程已不存在', 'error');
      return;
    }
    try {
      if (autoRemember) {
        await api.setRouteRemember(selectedDeviceId, selectedPid, role, session.exe_name);
        const device = get().devices.find((d) => d.id === selectedDeviceId);
        get().addLog(
          `已将 ${session.exe_name} 路由到 ${device?.name ?? selectedDeviceId}（已记忆）`,
          'success',
        );
      } else {
        await api.setRoute(selectedDeviceId, selectedPid, role);
        const device = get().devices.find((d) => d.id === selectedDeviceId);
        get().addLog(`已将 ${session.exe_name} 路由到 ${device?.name ?? selectedDeviceId}`, 'success');
      }
    } catch (e) {
      get().addLog(`路由失败: ${e}`, 'error');
    }
  },

  addLog: (message, level = 'info') => {
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    set((s) => ({
      logs: [...s.logs, { id: ++logId, timestamp: ts, message, level }].slice(-200),
    }));
  },
}));
