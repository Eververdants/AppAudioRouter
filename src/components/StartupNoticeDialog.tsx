import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { MAIN_THREAD_TRANSFORM, SPRING_GLIDE } from '@/lib/motion';
import type { ResetOutcome } from '@/lib/types';
import { useRouterStore } from '@/stores/routerStore';

/**
 * What this install is told about itself, once.
 *
 * Windows keeps a per-app endpoint assignment after the program that wrote it is
 * gone. 2.1.0 — the release that introduced them — stopped a route without
 * releasing the assignment, and could leave a program stuck on one device: the
 * system default no longer moves it, and a reboot does not help. Nothing in the
 * app can tell such a leftover from an assignment the user made by hand in the
 * volume mixer, so the launch after an update offers the reset instead of
 * running it silently. The offer is 2.1.0's alone: later releases return what
 * they pin on every path, so upgrading from them shows nothing at all.
 *
 * A fresh install never reaches this dialog — the full-screen wizard owns the
 * first run (see `StartupWizard`); this is the upgrade warning only.
 */
export function StartupNoticeDialog() {
  const { t } = useTranslation();
  const notice = useRouterStore((s) => s.startupNotice);
  const dismiss = useRouterStore((s) => s.dismissStartupNotice);
  const resetPinnedEndpoints = useRouterStore((s) => s.resetPinnedEndpoints);
  const [result, setResult] = useState<ResetOutcome | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (notice === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void dismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [notice, dismiss]);

  if (notice === null || notice.kind !== 'upgrade') return null;

  const runReset = async () => {
    setBusy(true);
    try {
      setResult(await resetPinnedEndpoints());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="startup-notice-title"
    >
      {/* The one surface in the app that is genuinely above the page, so the
          one that keeps a shadow: without it the dimmed backdrop alone does not
          say which of the two layers the words belong to. */}
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={SPRING_GLIDE}
        transformTemplate={MAIN_THREAD_TRANSFORM}
        className="bg-surface border border-line shadow-float w-full max-w-md rounded-panel p-5"
      >
        <h2 id="startup-notice-title" className="text-[15px] font-semibold tracking-tight text-text-primary">
          {t('startup.upgradeTitle')}
        </h2>
        <p className="mt-2 text-[12px] leading-relaxed text-text-secondary">
          {notice.previous_version === null
            ? t('startup.upgradeBody')
            : t('startup.upgradeBodyVersion', { version: notice.previous_version })}
        </p>

        <p className="mt-2 text-[11px] leading-relaxed text-text-muted">{t('startup.resetHint')}</p>

        {result !== null && (
          <p
            className={`mt-3 rounded border border-line px-3 py-2 font-mono text-[11px] leading-relaxed tabular-nums ${
              result.still_pinned.length === 0 ? 'text-accent' : 'text-text-secondary'
            }`}
          >
            {t('startup.resetDone', { n: result.released })}
            {result.still_pinned.length > 0 &&
              ` ${t('startup.resetRemaining', { processes: result.still_pinned.join(', ') })}`}
          </p>
        )}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => void runReset()}
            disabled={busy}
            className="rounded bg-accent px-3 py-1.5 text-[11px] font-medium text-accent-ink outline-none transition-colors hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-60"
          >
            {busy ? t('startup.resetting') : t('startup.resetAction')}
          </button>
          <button
            type="button"
            autoFocus
            onClick={() => void dismiss()}
            className="rounded border border-line px-3 py-1.5 text-[11px] font-medium text-text-secondary outline-none transition-colors hover:border-accent/50 hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {t('startup.dismiss')}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
