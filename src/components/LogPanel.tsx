import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { FADE, MAIN_THREAD_TRANSFORM } from '@/lib/motion';
import type { LogEntry } from '@/lib/types';
import { useRouterStore } from '@/stores/routerStore';

/**
 * One line of the log, remembered because a line never changes once written.
 *
 * The store caps the log at 200 entries and hands back a new array each time
 * one arrives, so the panel re-renders on every line — and every one of those
 * 200 rows re-rendered with it, each re-running the arrival animation for a
 * line that was already on screen. A single refresh writes several entries at
 * once, which is exactly the moment somebody is reading the panel.
 */
const LogRow = memo(function LogRow({ log }: { log: LogEntry }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={FADE}
      transformTemplate={MAIN_THREAD_TRANSFORM}
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
  );
});

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
 *
 * Two things the record owes the person reading it, now that it is also where
 * an error card sends them: a way to see only the failures (a session's worth
 * of ordinary "routed X" lines buries them), and a way to take the whole thing
 * away — a bug report is written somewhere else, and retyping a log is not a
 * reasonable thing to ask.
 */
export function LogPanel() {
  const { t } = useTranslation();
  const logs = useRouterStore((s) => s.logs);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');

  const errorCount = useMemo(() => logs.filter((log) => log.level === 'error').length, [logs]);
  const shown = useMemo(
    () => (errorsOnly ? logs.filter((log) => log.level === 'error') : logs),
    [logs, errorsOnly],
  );

  // Depend on the last visible log's id, not the array length — the store caps
  // logs at 200, so length stops changing once full and scrolling would stall.
  const lastLog = shown.at(-1);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [lastLog?.id]);

  const copyAll = async () => {
    const text = shown.map((log) => `[${log.timestamp}] ${log.message}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied('done');
    } catch {
      // A clipboard the webview refuses (no permission, no focus) is a copy
      // that did not happen, and the button has to say so rather than pretend.
      setCopied('failed');
    }
    window.setTimeout(() => setCopied('idle'), 1600);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The record's own controls. Quiet at rest: a filter nobody has pressed
          and a copy nobody needs yet should not compete with the lines. */}
      <div className="flex flex-none items-center justify-between gap-3 border-b border-line px-5 py-2">
        <div className="flex items-center gap-1" role="group" aria-label={t('logPanel.filter')}>
          <button
            type="button"
            aria-pressed={!errorsOnly}
            onClick={() => setErrorsOnly(false)}
            className={`pressable rounded-seg px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
              errorsOnly ? 'text-text-muted hover:text-text-primary' : 'text-text-primary'
            }`}
          >
            {t('logPanel.all')}
          </button>
          <button
            type="button"
            aria-pressed={errorsOnly}
            onClick={() => setErrorsOnly(true)}
            className={`pressable flex items-center gap-1 rounded-seg px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
              errorsOnly ? 'text-error' : 'text-text-muted hover:text-text-primary'
            }`}
          >
            {t('logPanel.errorsOnly')}
            {errorCount > 0 && (
              <span className="font-mono tabular-nums text-text-muted">{errorCount}</span>
            )}
          </button>
        </div>
        <button
          type="button"
          onClick={() => void copyAll()}
          disabled={shown.length === 0}
          className="pressable rounded-seg px-2 py-1 text-xs text-text-muted outline-none hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-40 disabled:hover:text-text-muted"
        >
          {copied === 'done'
            ? t('logPanel.copied')
            : copied === 'failed'
              ? t('logPanel.copyFailed')
              : t('logPanel.copy')}
        </button>
      </div>

      {shown.length === 0 ? (
        <p className="px-5 py-8 text-center text-xs text-text-muted">
          {errorsOnly ? t('logPanel.emptyErrors') : t('logPanel.empty')}
        </p>
      ) : (
        // `tabIndex` because this is the only scrollable region on the page that
        // a keyboard could otherwise not reach: the newest line is scrolled to by
        // the app, but reading back through the record takes an arrow key, and a
        // plain div swallows it. No live region — the log gains a line for
        // ordinary audio events, and announcing every one of them would be a
        // second voice talking over the interface.
        <div
          tabIndex={0}
          className="min-h-0 flex-1 overflow-y-auto px-5 py-2 font-mono text-xs leading-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
        >
          {shown.map((log) => (
            <LogRow key={log.id} log={log} />
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
