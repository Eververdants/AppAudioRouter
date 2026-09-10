import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import appIcon from '@/assets/app-icon.png';
import { ConcentricRouter } from '@/components/ConcentricRouter';
import { ProcessList } from '@/components/ProcessList';
import { LanguageToggle } from '@/components/LanguageToggle';
import { LogPanel } from '@/components/LogPanel';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useTheme } from '@/hooks/useTheme';
import { useRouterStore } from '@/stores/routerStore';

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
  const { t } = useTranslation();
  const { theme, toggle } = useTheme();
  const refreshDevices = useRouterStore((s) => s.refreshDevices);
  const refreshSessions = useRouterStore((s) => s.refreshSessions);
  const autoRemember = useRouterStore((s) => s.autoRemember);
  const toggleAutoRemember = useRouterStore((s) => s.toggleAutoRemember);

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

  return (
    <div className="flex h-screen flex-col bg-bg-primary text-text-primary">
      {/* Header */}
      <motion.header
        {...panelEnter}
        className="flex flex-none items-center justify-between border-b border-border px-6 py-3"
      >
        <div className="flex items-center gap-3">
          <img src={appIcon} alt="App Audio Router" className="h-8 w-8 rounded-lg" />
          <h1 className="text-sm font-semibold">App Audio Router</h1>
          <span className="rounded-full bg-accent-muted px-2 py-0.5 text-[10px] font-medium text-accent">
            v2.0
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Auto-remember lives here so it stays reachable when the log
              panel is hidden on narrow windows. */}
          <label className="flex cursor-pointer items-center gap-2 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={autoRemember}
              onChange={toggleAutoRemember}
              className="h-3.5 w-3.5 rounded border-border accent-accent"
            />
            {t('header.autoRemember')}
          </label>
          <LanguageToggle />
          <ThemeToggle theme={theme} onToggle={toggle} />
        </div>
      </motion.header>

      {/* Main content */}
      <div className="flex flex-1 gap-4 overflow-hidden p-4">
        {/* Left panel: process list (narrower below lg to leave room for the router) */}
        <motion.aside {...panelEnter} className="w-52 flex-shrink-0 lg:w-64">
          <ProcessList />
        </motion.aside>

        {/* Center: concentric router */}
        <motion.main
          {...panelEnter}
          className="flex flex-1 items-center justify-center rounded-xl border border-border bg-bg-secondary"
        >
          <ConcentricRouter />
        </motion.main>

        {/* Right panel: log (hidden below lg to keep the router usable) */}
        <motion.aside {...panelEnter} className="hidden w-72 flex-shrink-0 lg:block">
          <LogPanel />
        </motion.aside>
      </div>
    </div>
  );
}
