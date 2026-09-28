import { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useDecorativeMotion } from '@/hooks/useDecorativeMotion';
import { useRouterStore } from '@/stores/routerStore';

export function LogPanel() {
  const { t } = useTranslation();
  const logs = useRouterStore((s) => s.logs);
  const awake = useDecorativeMotion();
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
        {/* live dot: subtle heartbeat so the panel reads as "recording". Cheap on
            its own, but one endless loop anywhere keeps the frame ticker running,
            and every frame re-composites the glass — so it stops with the rest of
            the decorative motion and the dot simply stays lit. */}
        <motion.span
          aria-hidden="true"
          className="h-1.5 w-1.5 rounded-full bg-success"
          animate={awake ? { opacity: [1, 0.3, 1] } : { opacity: 1 }}
          transition={
            awake
              ? { duration: 2.4, repeat: Infinity, ease: 'easeInOut' }
              : { duration: 0.4, ease: 'easeOut' }
          }
        />
      </h2>

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
                  ? 'text-success'
                  : log.level === 'error'
                    ? 'text-error'
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
