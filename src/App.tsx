import { useEffect } from 'react';
import { motion } from 'framer-motion';
import { ConcentricRouter } from '@/components/ConcentricRouter';
import { ProcessList } from '@/components/ProcessList';
import { LogPanel } from '@/components/LogPanel';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useTheme } from '@/hooks/useTheme';
import { useRouterStore } from '@/stores/routerStore';

export default function App() {
  const { theme, toggle } = useTheme();
  const refreshDevices = useRouterStore((s) => s.refreshDevices);
  const refreshSessions = useRouterStore((s) => s.refreshSessions);

  useEffect(() => {
    refreshDevices();
    refreshSessions();
  }, [refreshDevices, refreshSessions]);

  return (
    <div className="flex h-screen flex-col bg-bg-primary text-text-primary">
      {/* Header */}
      <motion.header
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center justify-between border-b border-border px-6 py-3"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-white">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2v20M2 12h20M4.93 4.93l14.14 14.14M19.07 4.93L4.93 19.07" />
            </svg>
          </div>
          <h1 className="text-sm font-semibold">App Audio Router</h1>
          <span className="rounded-full bg-accent-muted px-2 py-0.5 text-[10px] font-medium text-accent">
            v2.0
          </span>
        </div>
        <ThemeToggle theme={theme} onToggle={toggle} />
      </motion.header>

      {/* Main content */}
      <div className="flex flex-1 gap-4 overflow-hidden p-4">
        {/* Left panel: process list */}
        <motion.aside
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.1 }}
          className="w-64 flex-shrink-0"
        >
          <ProcessList />
        </motion.aside>

        {/* Center: concentric router */}
        <motion.main
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.2 }}
          className="flex flex-1 items-center justify-center rounded-xl border border-border bg-bg-secondary"
        >
          <ConcentricRouter />
        </motion.main>

        {/* Right panel: log */}
        <motion.aside
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.15 }}
          className="w-72 flex-shrink-0"
        >
          <LogPanel />
        </motion.aside>
      </div>
    </div>
  );
}
