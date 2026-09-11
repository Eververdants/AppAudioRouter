import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useRouterStore } from '@/stores/routerStore';

const container = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.05 },
  },
};

const item = {
  hidden: { opacity: 0, x: -10 },
  show: { opacity: 1, x: 0 },
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
    <div className="flex h-full flex-col rounded-xl border border-border bg-bg-secondary p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-primary">{t('processList.title')}</h2>
        <button
          onClick={refreshSessions}
          className="rounded-md px-2 py-1 text-xs text-text-muted transition-colors hover:bg-bg-tertiary hover:text-accent"
        >
          {t('processList.refresh')}
        </button>
      </div>

      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="flex-1 space-y-1.5 overflow-y-auto"
      >
        {sessions.length === 0 ? (
          <p className="py-8 text-center text-xs text-text-muted">
            {t('processList.empty')}
            <br />
            <span className="text-[10px]">{t('processList.emptyHint')}</span>
          </p>
        ) : (
          sessions.map((session) => {
            const routedCount = routedPids[session.pid]?.length ?? 0;
            return (
              <motion.div key={session.pid} variants={item} className="relative">
                <button
                  onClick={() => selectProcess(session.pid)}
                  className={`w-full rounded-lg px-3 py-2 pr-9 text-left text-xs transition-all ${
                    session.pid === selectedPid
                      ? 'bg-accent/10 text-accent ring-1 ring-accent'
                      : 'text-text-secondary hover:bg-bg-tertiary'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium">{session.exe_name}</span>
                    {routedCount > 0 && (
                      <span
                        title={t('processList.routedBadge', { n: routedCount })}
                        className="flex h-4 min-w-4 flex-none items-center justify-center rounded-full bg-accent px-1 text-[9px] font-semibold leading-none text-white"
                      >
                        {routedCount}
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-text-muted">PID {session.pid}</div>
                </button>
                {routedCount > 0 && (
                  <button
                    onClick={() => void stopRoute(session.pid)}
                    title={t('processList.stopRoute')}
                    aria-label={t('processList.stopRoute')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-500"
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
                  </button>
                )}
              </motion.div>
            );
          })
        )}
      </motion.div>
    </div>
  );
}
