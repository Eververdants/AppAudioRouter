import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { FADE, SPRING_GLIDE } from '@/lib/motion';
import { useRouterStore } from '@/stores/routerStore';

/** Height of the expanded log — a glance at what happened, not a console. */
const EXPANDED_HEIGHT = 176;

/**
 * What the app did, as a strip under the stage.
 *
 * The log is the expert surface: it matters when something went wrong and is
 * noise the rest of the time. So it lives collapsed as a thin bar that still
 * shows the latest line — the one sentence a novice actually needs — and
 * expands only on demand. It never opens by itself: the main screen is
 * remounted on every return from settings, and a panel that reopens each time
 * is a panel the user has to keep closing.
 */
export function LogPanel() {
  const { t } = useTranslation();
  const logs = useRouterStore((s) => s.logs);
  const advancedMode = useRouterStore((s) => s.advancedMode);
  const [expanded, setExpanded] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Turning the advanced switch off folds the log away; turning it on does
  // not open it — opening is always the user's own click.
  useEffect(() => {
    if (!advancedMode) setExpanded(false);
  }, [advancedMode]);

  // Depend on the last log's id, not the array length — the store caps
  // logs at 200, so length stops changing once full and scrolling would stall.
  const lastLog = logs.at(-1);
  useEffect(() => {
    if (expanded) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lastLog?.id, expanded]);

  return (
    <div className="flex flex-none flex-col rounded-2xl border border-glass bg-glass shadow-glass backdrop-blur-xl">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={t(expanded ? 'logPanel.collapse' : 'logPanel.expand')}
        className="flex items-center gap-2 px-4 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        <span className="flex-none text-[11px] font-semibold text-text-primary">
          {t('logPanel.title')}
        </span>
        {/* Still on purpose: a dot that pulses forever sits at the edge of
            vision and is the first thing that makes a panel tiring. */}
        <span aria-hidden="true" className="h-1.5 w-1.5 flex-none rounded-full bg-success" />
        {!expanded && lastLog !== undefined && (
          <span
            className={`min-w-0 flex-1 truncate font-mono text-[10px] ${
              lastLog.level === 'error'
                ? 'text-error'
                : lastLog.level === 'success'
                  ? 'text-success'
                  : 'text-text-muted'
            }`}
          >
            {lastLog.message}
          </span>
        )}
        <motion.svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          animate={{ rotate: expanded ? 180 : 0 }}
          transition={SPRING_GLIDE}
          className="ml-auto flex-none text-text-muted"
        >
          <polyline points="6 9 12 15 18 9" />
        </motion.svg>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="log-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: EXPANDED_HEIGHT, opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={SPRING_GLIDE}
            className="overflow-hidden"
          >
            <div className="h-full overflow-y-auto border-t border-border/50 px-4 py-2 font-mono text-[11px] leading-4">
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
                    <span className="tabular-nums text-text-muted">[{log.timestamp}]</span>{' '}
                    {log.message}
                  </motion.div>
                ))}
              </AnimatePresence>
              <div ref={bottomRef} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
