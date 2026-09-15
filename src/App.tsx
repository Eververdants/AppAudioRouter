import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { listen } from '@tauri-apps/api/event';
import { ConcentricRouter } from '@/components/ConcentricRouter';
import { DelayPanel } from '@/components/DelayPanel';
import { ProcessList } from '@/components/ProcessList';
import { LogPanel } from '@/components/LogPanel';
import { SettingsPage } from '@/components/SettingsPage';
import { TitleBar } from '@/components/TitleBar';
import { useRouterStore } from '@/stores/routerStore';
import type { DuplicationStoppedEvent } from '@/lib/types';
import { revealMainWindow } from '@/lib/window';

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
        className="absolute -bottom-24 left-[2%] h-72 w-72 rounded-full bg-[#38bdf8]/15 blur-[110px]"
        animate={{ x: [0, 28, -22, 0], y: [0, -22, 14, 0] }}
        transition={{ duration: 32, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute left-[44%] top-[34%] h-64 w-64 rounded-full bg-[#c084fc]/10 blur-[100px]"
        animate={{ x: [0, -24, 26, 0], y: [0, 18, -14, 0] }}
        transition={{ duration: 38, repeat: Infinity, ease: 'easeInOut' }}
      />
    </div>
  );
}

export default function App() {
  const refreshDevices = useRouterStore((s) => s.refreshDevices);
  const refreshSessions = useRouterStore((s) => s.refreshSessions);
  const loadDelaySettings = useRouterStore((s) => s.loadDelaySettings);
  const loadVolumeLimits = useRouterStore((s) => s.loadVolumeLimits);
  const [view, setView] = useState<'router' | 'settings'>('router');

  useEffect(() => {
    // The window is created hidden so nobody sees the unstyled shell. This runs
    // after the first commit, i.e. once there is something real to show.
    void revealMainWindow();
  }, []);

  useEffect(() => {
    void loadDelaySettings();
    void loadVolumeLimits();
  }, [loadDelaySettings, loadVolumeLimits]);

  useEffect(() => {
    // Enumerating devices and sessions walks the Core Audio graph on the Rust
    // side, and every result appends a log entry. Running that during the first
    // render made the IPC round-trips and the extra re-renders compete with the
    // initial paint, so wait until the first frame is on screen.
    return afterFirstPaint(() => {
      void refreshDevices();
      void refreshSessions();
    });
  }, [refreshDevices, refreshSessions]);

  useEffect(() => {
    // Duplication engines report their end (user stop, process exit, error)
    // through this backend event so the badges stay honest.
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<DuplicationStoppedEvent>('duplication-stopped', (event) => {
      useRouterStore.getState().handleDuplicationStopped(event.payload);
    }).then((off) => {
      if (disposed) off();
      else unlisten = off;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

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

            {/* Center: concentric router + the delay panel on a glass stage */}
            <motion.main
              {...panelEnter}
              className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 rounded-2xl border border-glass bg-glass p-3 shadow-glass backdrop-blur-xl"
            >
              {/* min-h-0 lets the stage shrink so the delay panel always fits */}
              <div className="min-h-0 w-full flex-1">
                <ConcentricRouter />
              </div>
              <DelayPanel />
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
