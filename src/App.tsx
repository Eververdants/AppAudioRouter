import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { listen } from '@tauri-apps/api/event';
import { ConcentricRouter } from '@/components/ConcentricRouter';
import { DelayBar } from '@/components/DelayBar';
import { ProcessList } from '@/components/ProcessList';
import { LogPanel } from '@/components/LogPanel';
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

export default function App() {
  const refreshDevices = useRouterStore((s) => s.refreshDevices);
  const refreshSessions = useRouterStore((s) => s.refreshSessions);
  const loadDelaySettings = useRouterStore((s) => s.loadDelaySettings);

  useEffect(() => {
    // The window is created hidden so nobody sees the unstyled shell. This runs
    // after the first commit, i.e. once there is something real to show.
    void revealMainWindow();
  }, []);

  useEffect(() => {
    void loadDelaySettings();
  }, [loadDelaySettings]);

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
    <div className="flex h-screen flex-col bg-bg-primary text-text-primary">
      {/* The native caption bar is disabled, so this bar is the window frame. */}
      <TitleBar />

      {/* Main content */}
      <div className="flex flex-1 gap-4 overflow-hidden p-4">
        {/* Left panel: process list (narrower below lg to leave room for the router) */}
        <motion.aside {...panelEnter} className="w-52 flex-shrink-0 lg:w-64">
          <ProcessList />
        </motion.aside>

        {/* Center: concentric router + delay compensation bar */}
        <motion.main
          {...panelEnter}
          className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-border bg-bg-secondary p-3"
        >
          {/* min-h-0 lets the stage shrink so the delay bar always fits */}
          <div className="min-h-0 w-full flex-1">
            <ConcentricRouter />
          </div>
          <DelayBar />
        </motion.main>

        {/* Right panel: log (hidden below lg to keep the router usable) */}
        <motion.aside {...panelEnter} className="hidden w-72 flex-shrink-0 lg:block">
          <LogPanel />
        </motion.aside>
      </div>
    </div>
  );
}
