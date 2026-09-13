import { motion, AnimatePresence, type Variants } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useRouterStore } from '@/stores/routerStore';

const container: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.05 },
  },
};

const item: Variants = {
  hidden: { opacity: 0, x: -8 },
  show: { opacity: 1, x: 0, transition: { type: 'spring', stiffness: 400, damping: 30 } },
};

export function ProcessList() {
  const { t } = useTranslation();
  const sessions = useRouterStore((s) => s.sessions);
  const selectedPid = useRouterStore((s) => s.selectedPid);
  const routedPids = useRouterStore((s) => s.routedPids);
  const selectProcess = useRouterStore((s) => s.selectProcess);
  const stopRoute = useRouterStore((s) => s.stopRoute);
  const refreshSessions = useRouterStore((s) => s.refreshSessions);

  return (
    <div className="flex h-full flex-col rounded-2xl border border-glass bg-glass p-4 shadow-glass backdrop-blur-xl">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-primary">{t('processList.title')}</h2>
        <motion.button
          onClick={refreshSessions}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.92 }}
          transition={{ type: 'spring', stiffness: 500, damping: 25 }}
          className="rounded-md px-2 py-1 text-xs text-text-muted transition-colors hover:bg-bg-tertiary hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          {t('processList.refresh')}
        </motion.button>
      </div>

      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="flex-1 space-y-1.5 overflow-y-auto"
      >
        {sessions.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="text-text-muted/60"
            >
              <path d="M11 5 6 9H2v6h4l5 4V5z" />
              <line x1="22" y1="9" x2="16" y2="15" />
              <line x1="16" y1="9" x2="22" y2="15" />
            </svg>
            <p className="text-xs leading-relaxed text-text-muted">
              {t('processList.empty')}
              <br />
              <span className="text-[10px]">{t('processList.emptyHint')}</span>
            </p>
          </div>
        ) : (
          sessions.map((session) => {
            const routedCount = routedPids[session.pid]?.length ?? 0;
            const isSelected = session.pid === selectedPid;
            return (
              <motion.div key={session.pid} variants={item} className="relative">
                <motion.button
                  onClick={() => selectProcess(session.pid)}
                  whileTap={{ scale: 0.97 }}
                  transition={{ type: 'spring', stiffness: 500, damping: 28 }}
                  className="relative w-full rounded-lg px-3 py-2 pr-9 text-left text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60"
                >
                  {/* Sliding selection highlight, shared across all items */}
                  {isSelected && (
                    <motion.span
                      layoutId="process-active-pill"
                      className="absolute inset-0 rounded-lg bg-accent-muted ring-1 ring-accent/50"
                      transition={{ type: 'spring', stiffness: 450, damping: 34 }}
                    />
                  )}
                  <span
                    className={`relative flex items-center gap-1.5 font-medium ${
                      isSelected ? 'text-accent' : 'text-text-secondary'
                    }`}
                  >
                    <span className="truncate">{session.exe_name}</span>
                    {routedCount > 0 && (
                      <span
                        title={t('processList.routedBadge', { n: routedCount })}
                        className="flex h-4 min-w-4 flex-none items-center justify-center rounded-full bg-accent px-1 text-[9px] font-semibold leading-none text-white"
                      >
                        {routedCount}
                      </span>
                    )}
                  </span>
                  <span className="relative text-[10px] text-text-muted">PID {session.pid}</span>
                </motion.button>
                <AnimatePresence>
                  {routedCount > 0 && (
                    <motion.button
                      initial={{ opacity: 0, scale: 0.6 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.6 }}
                      whileHover={{ scale: 1.15 }}
                      whileTap={{ scale: 0.9 }}
                      onClick={() => void stopRoute(session.pid)}
                      title={t('processList.stopRoute')}
                      aria-label={t('processList.stopRoute')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-text-muted transition-colors hover:bg-error/10 hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error/50"
                    >
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 10 10"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      >
                        <line x1="1" y1="1" x2="9" y2="9" />
                        <line x1="9" y1="1" x2="1" y2="9" />
                      </svg>
                    </motion.button>
                  )}
                </AnimatePresence>
              </motion.div>
            );
          })
        )}
      </motion.div>
    </div>
  );
}
