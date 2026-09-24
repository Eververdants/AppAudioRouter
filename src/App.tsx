import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { ConcentricRouter } from '@/components/ConcentricRouter';
import { ProcessList } from '@/components/ProcessList';
import { LogPanel } from '@/components/LogPanel';
import { SettingsPage } from '@/components/SettingsPage';
import { TitleBar } from '@/components/TitleBar';
import { useBackendEvent } from '@/hooks/useBackendEvent';
import { useRouterStore } from '@/stores/routerStore';
import type { AudioChangedEvent, DuplicationStoppedEvent } from '@/lib/types';
import { isSilentLaunch, setTrayLabels } from '@/lib/invoke';
import { revealMainWindow } from '@/lib/window';

/**
 * A single hotplug or a device waking up reaches Core Audio as a burst of
 * notifications (added, then default, then state, then property). One
 * re-enumeration at the end of the burst is all the UI needs.
 */
const AUDIO_SYNC_DEBOUNCE_MS = 400;

/**
 * Entrance animation for the three panels. Kept short and free of staggering:
 * anything longer delays the moment the user can actually read the screen,
 * which is the part of "startup time" they perceive.
 */
const panelEnter = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.18, ease: 'easeOut' },
} as const;

/** Runs `task` once the browser is idle, falling back to a task tick. */
function afterFirstPaint(task: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(task, { timeout: 1000 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(task, 0);
  return () => window.clearTimeout(handle);
}

/**
 * Ambient light blobs drifting behind the glass panels. Pure atmosphere —
 * the backdrop-blur on the panels turns them into the colour the glass
 * "refracts". Mirror easing keeps each drift seamless.
 */
function AmbientLight() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <motion.div
        className="absolute -top-32 right-[6%] h-80 w-80 rounded-full bg-accent/15 blur-[110px]"
        animate={{ x: [0, -36, 12, 0], y: [0, 26, -16, 0] }}
        transition={{ duration: 26, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute -bottom-24 left-[2%] h-72 w-72 rounded-full bg-[#3b82f6]/15 blur-[110px]"
        animate={{ x: [0, 28, -22, 0], y: [0, -22, 14, 0] }}
        transition={{ duration: 32, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute left-[44%] top-[34%] h-64 w-64 rounded-full bg-[#2dd4bf]/10 blur-[100px]"
        animate={{ x: [0, -24, 26, 0], y: [0, 18, -14, 0] }}
        transition={{ duration: 38, repeat: Infinity, ease: 'easeInOut' }}
      />
    </div>
  );
}

export default function App() {
  const { t, i18n } = useTranslation();
  const refreshDevices = useRouterStore((s) => s.refreshDevices);
  const refreshSessions = useRouterStore((s) => s.refreshSessions);
  const loadDefaultDevice = useRouterStore((s) => s.loadDefaultDevice);
  const loadDelaySettings = useRouterStore((s) => s.loadDelaySettings);
  const loadDeviceVolumes = useRouterStore((s) => s.loadDeviceVolumes);
  const loadShellSettings = useRouterStore((s) => s.loadShellSettings);
  const reconcileActiveDuplications = useRouterStore((s) => s.reconcileActiveDuplications);
  const [view, setView] = useState<'router' | 'settings'>('router');

  useEffect(() => {
    // The window is created hidden so nobody sees the unstyled shell. This runs
    // after the first commit, i.e. once there is something real to show.
    //
    // A launch at sign-in carries --hidden, because a background tool that puts a
    // window in front of a user who did not ask for one is not background: the
    // tray is the way in from there.
    let cancelled = false;
    void isSilentLaunch()
      .catch((error) => {
        console.warn('[window] silent-launch check failed', error);
        return false;
      })
      .then((silent) => {
        if (!cancelled && !silent) void revealMainWindow();
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void loadDelaySettings();
    void loadDeviceVolumes();
  }, [loadDelaySettings, loadDeviceVolumes]);

  useEffect(() => {
    // The tray menu is a native control and cannot read i18next, so its labels
    // are pushed over whenever the UI language changes.
    void setTrayLabels(t('tray.show'), t('tray.quit')).catch((error) => {
      // A plain browser tab during `vite dev` has no tray at all.
      console.warn('[tray] could not set the menu labels', error);
    });
  }, [t, i18n.language]);

  useEffect(() => {
    // Enumerating devices and sessions walks the Core Audio graph on the Rust
    // side, and every result appends a log entry. Running that during the first
    // render made the IPC round-trips and the extra re-renders compete with the
    // initial paint, so wait until the first frame is on screen. The system
    // default device is fetched alongside, since it is what a process is
    // associated with until it is routed somewhere explicitly.
    return afterFirstPaint(() => {
      void refreshDevices();
      void loadDefaultDevice();
      void refreshSessions();
      // Routes can outlast the process (the audio service persists them), so
      // on boot the backend may already be duplicating for some PIDs while the
      // store still thinks nothing is routed. Reconcile before first paint so
      // the badges match reality from the moment the window shows.
      void reconcileActiveDuplications();
      // The tray preference and the startup registry entry are only read by the
      // settings page, so they wait for the first paint like the rest.
      void loadShellSettings();
    });
  }, [
    refreshDevices,
    loadDefaultDevice,
    refreshSessions,
    reconcileActiveDuplications,
    loadShellSettings,
  ]);

  // Duplication engines report their end (user stop, process exit, error) through
  // this backend event so the badges stay honest.
  useBackendEvent<DuplicationStoppedEvent>('duplication-stopped', (payload) => {
    useRouterStore.getState().handleDuplicationStopped(payload);
  });

  // Core Audio says something moved — a device was plugged in, an app started or
  // stopped playing. React on a timer instead of per notification, and read the
  // store at fire time so a route applied during the wait is not overwritten.
  const pendingSync = useRef<AudioChangedEvent | null>(null);
  const syncTimer = useRef<number | null>(null);
  const queueAudioSync = useCallback((changed: AudioChangedEvent) => {
    // Two emits can straddle the debounce window; merge so neither half of what
    // they reported gets dropped by the later one.
    const merged = pendingSync.current ?? { devices: false, sessions: false };
    merged.devices = merged.devices || changed.devices;
    merged.sessions = merged.sessions || changed.sessions;
    pendingSync.current = merged;

    if (syncTimer.current !== null) window.clearTimeout(syncTimer.current);
    syncTimer.current = window.setTimeout(() => {
      syncTimer.current = null;
      const next = pendingSync.current;
      pendingSync.current = null;
      if (next) void useRouterStore.getState().syncFromNotification(next);
    }, AUDIO_SYNC_DEBOUNCE_MS);
  }, []);
  useBackendEvent<AudioChangedEvent>('audio-changed', queueAudioSync);

  useEffect(
    () => () => {
      if (syncTimer.current !== null) window.clearTimeout(syncTimer.current);
      pendingSync.current = null;
    },
    [],
  );

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-bg-primary text-text-primary">
      <AmbientLight />

      {/* The native caption bar is disabled, so this bar is the window frame. */}
      <TitleBar
        settingsOpen={view === 'settings'}
        onToggleSettings={() => setView((v) => (v === 'settings' ? 'router' : 'settings'))}
      />

      {/* Content area: the router view and the settings page swap in place.
          Entrance-only transitions (no AnimatePresence): the outgoing view
          unmounts immediately, which keeps the swap stuck-free. */}
      <div className="relative flex flex-1 overflow-hidden p-3">
        {view === 'router' ? (
          <motion.div
            key="router"
            initial={{ opacity: 0, x: -24 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 34 }}
            className="flex min-h-0 flex-1 gap-3"
          >
            {/* Left panel: process list (narrower below lg to leave room for the router) */}
            <motion.aside {...panelEnter} className="w-48 flex-shrink-0 md:w-56 lg:w-64">
              <ProcessList />
            </motion.aside>

            {/* Center: the concentric router on a glass stage. Device delays are
                set on the device nodes themselves, so the stage owns the whole
                column. */}
            <motion.main
              {...panelEnter}
              className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 rounded-2xl border border-glass bg-glass p-3 shadow-glass backdrop-blur-xl"
            >
              <div className="min-h-0 w-full flex-1">
                <ConcentricRouter />
              </div>
            </motion.main>

            {/* Right panel: log (hidden below lg to keep the router usable) */}
            <motion.aside {...panelEnter} className="hidden w-72 flex-shrink-0 lg:block">
              <LogPanel />
            </motion.aside>
          </motion.div>
        ) : (
          <motion.div
            key="settings"
            initial={{ opacity: 0, x: 36 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 34 }}
            className="min-h-0 flex-1"
          >
            <SettingsPage onBack={() => setView('router')} />
          </motion.div>
        )}
      </div>
    </div>
  );
}
