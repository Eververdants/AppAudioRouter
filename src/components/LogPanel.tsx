import { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { FADE } from '@/lib/motion';
import { useRouterStore } from '@/stores/routerStore';

export function LogPanel() {
  const { t } = useTranslation();
  const logs = useRouterStore((s) => s.logs);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Depend on the last log's id, not the array length — the store caps
  // logs at 200, so length stops changing once full and scrolling would stall.
  const lastLogId = logs.at(-1)?.id;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lastLogId]);

  return (
    <div className="flex h-full flex-col rounded-2xl border border-glass bg-glass p-4 shadow-glass backdrop-blur-xl">
      <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-text-primary">
        {t('logPanel.title')}
        {/* Still on purpose: a dot that pulses forever sits at the edge of
            vision and is the first thing that makes a panel tiring. */}
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-success" />
      </h2>

      <div className="flex-1 overflow-y-auto font-mono text-[11px] leading-4">
        <AnimatePresence initial={false}>
          {logs.map((log) => (
            <motion.div
              key={log.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={FADE}
              className={`py-0.5 [overflow-wrap:anywhere] ${
                log.level === 'success'
                  ? 'text-success'
                  : log.level === 'error'
                    ? 'text-error'
                    : 'text-text-secondary'
              }`}
            >
              <span className="tabular-nums text-text-muted">[{log.timestamp}]</span> {log.message}
            </motion.div>
          ))}
        </AnimatePresence>
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
