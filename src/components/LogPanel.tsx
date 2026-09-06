import { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useRouterStore } from '@/stores/routerStore';

export function LogPanel() {
  const { t } = useTranslation();
  const logs = useRouterStore((s) => s.logs);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs.length]);

  return (
    <div className="flex h-full flex-col rounded-xl border border-border bg-bg-secondary p-4">
      <h2 className="mb-3 text-sm font-semibold text-text-primary">{t('logPanel.title')}</h2>

      <div className="flex-1 overflow-y-auto font-mono text-[11px]">
        <AnimatePresence initial={false}>
          {logs.map((log) => (
            <motion.div
              key={log.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className={`py-0.5 ${
                log.level === 'success'
                  ? 'text-green-500'
                  : log.level === 'error'
                    ? 'text-red-500'
                    : 'text-text-secondary'
              }`}
            >
              <span className="text-text-muted">[{log.timestamp}]</span> {log.message}
            </motion.div>
          ))}
        </AnimatePresence>
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
