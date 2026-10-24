import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Spinner } from '@/components/ui/Spinner';
import type { ComputedDelays } from '@/components/calibration/types';
import { FADE, MAIN_THREAD_TRANSFORM } from '@/lib/motion';

/**
 * The results screen: the proposal one choice of baseline produces, and the
 * write that takes it.
 *
 * Tapping a row re-picks the baseline. The offsets are all differences against
 * each other, so that is arithmetic rather than a second measurement — the
 * numbers never came from a device's absolute lateness, only from how they
 * compare. A device the engine's own pipeline already outruns cannot be caught
 * up: it is shown at 0 and the screen says how late it will still be.
 */
export function ResultScreen({
  computed,
  baselineId,
  deviceName,
  applying,
  applyFailed,
  setApplyFailed,
  setBaselineId,
  beginMeasure,
  apply,
}: {
  computed: ComputedDelays;
  baselineId: string;
  deviceName: (id: string) => string;
  applying: boolean;
  applyFailed: boolean;
  setApplyFailed: (failed: boolean) => void;
  setBaselineId: (id: string) => void;
  beginMeasure: () => void;
  apply: () => Promise<void>;
}) {
  const { t } = useTranslation();
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={FADE}
      transformTemplate={MAIN_THREAD_TRANSFORM}
    >
      <p className="mt-2 text-[12px] leading-relaxed text-text-secondary">
        {t('calibration.baselineNote', { name: deviceName(baselineId) })}
      </p>
      <div className="mt-3">
        {Object.entries(computed.values).map(([id, value]) => (
          <button
            key={id}
            type="button"
            // Inert while the write is in flight: the numbers going out
            // were taken from this proposal, and a new baseline mid-write
            // would leave the screen describing a set that was never sent.
            disabled={id === baselineId || applying}
            onClick={() => {
              // The refusal described the numbers that were just sent; a
              // different proposal makes it stale.
              setApplyFailed(false);
              setBaselineId(id);
            }}
            aria-pressed={id === baselineId}
            className={`pressable flex w-full items-center justify-between gap-3 border-b border-line py-2 text-left outline-none last:border-b-0 focus-visible:ring-2 focus-visible:ring-accent/60 ${
              id === baselineId
                ? 'cursor-default text-text-primary'
                : 'text-text-secondary hover:text-accent'
            }`}
          >
            <span className="min-w-0 flex-1 truncate text-xs">{deviceName(id)}</span>
            <span className="flex-none text-xs text-text-muted">
              {id === baselineId ? t('calibration.rolePrimary') : t('calibration.roleCopy')}
            </span>
            <span className="w-16 flex-none text-right font-mono text-[11px] tabular-nums text-text-primary">
              {id === baselineId ? '—' : `+${value} ms`}
            </span>
          </button>
        ))}
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-text-muted">
        {t('calibration.rebaseHint')}
      </p>
      {computed.lagging.map(({ id, diff, late }) => (
        <p
          key={id}
          className="mt-2 rounded-seg border border-line px-3 py-2 text-[11px] leading-relaxed text-text-secondary"
        >
          {diff < 0
            ? t('calibration.laggingBehind', {
                device: deviceName(id),
                slow: -diff,
                late,
              })
            : t('calibration.laggingClose', { device: deviceName(id), diff, late })}
        </p>
      ))}
      {applyFailed && (
        <p className="mt-2 text-[11px] leading-relaxed text-text-secondary">
          {t('calibration.applyFailed')}
        </p>
      )}
      <p className="mt-2 text-[11px] leading-relaxed text-text-muted">
        {t('calibration.finetune')}
      </p>
      <div className="mt-4 flex items-center justify-end gap-2">
        <button
          type="button"
          disabled={applying}
          onClick={beginMeasure}
          className="pressable rounded-ctl border border-line px-3 py-1.5 text-[11px] font-medium text-text-secondary outline-none hover:border-accent/50 hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-60"
        >
          {t('calibration.again')}
        </button>
        <button
          type="button"
          disabled={applying}
          onClick={() => void apply()}
          className="pressable flex items-center gap-1.5 rounded-ctl bg-accent px-3 py-1.5 text-[11px] font-medium text-accent-ink outline-none hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-60"
        >
          {applying && <Spinner size={11} />}
          {applying ? t('calibration.applying') : t('calibration.apply')}
        </button>
      </div>
    </motion.div>
  );
}
