import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { FADE } from '@/lib/motion';
import { useRouterStore } from '@/stores/routerStore';

/**
 * What the app did, as a full-height list behind the activity tab.
 *
 * The log is the expert surface: it matters when something went wrong and is
 * noise the rest of the time. It used to be a strip that folded away beneath
 * the router and reappeared on every return from settings; as a tab it is opt-in
 * by construction — nothing to close, nothing that can reopen itself, and no
 * switch needed to keep it out of the way.
 *
 * Rows are dense and monospaced so a timestamp column lines up and a level is
 * readable at a glance; the newest entry is scrolled into view, because a log
 * you have to chase is a log nobody reads.
 */
export function LogPanel() {
  const { t } = useTranslation();
  const logs = useRouterStore((s) => s.logs);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Depend on the last log's id, not the array length — the store caps
  // logs at 200, so length stops changing once full and scrolling would stall.
  const lastLog = logs.at(-1);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [lastLog?.id]);

  if (logs.length === 0) {
    return <p className="px-5 py-8 text-center text-[11px] text-text-muted">{t('logPanel.empty')}</p>;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-2 font-mono text-[11px] leading-4">
      {logs.map((log) => (
        <motion.div
          key={log.id}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={FADE}
          className={`flex gap-3 py-0.5 [overflow-wrap:anywhere] ${
            log.level === 'success'
              ? 'text-success'
              : log.level === 'error'
                ? 'text-error'
                : 'text-text-secondary'
          }`}
        >
          <span className="flex-none tabular-nums text-text-muted">[{log.timestamp}]</span>
          <span className="min-w-0">{log.message}</span>
        </motion.div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
