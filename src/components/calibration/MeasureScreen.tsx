import { type RefObject } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { MIN_ROUNDS, MIN_VALID } from '@/components/calibration/constants';
import type { MeasureFailure, Step } from '@/components/calibration/types';
import { FADE, MAIN_THREAD_TRANSFORM, SPRING_TAP } from '@/lib/motion';

/**
 * The measurement screen: one device sounding at a time, one button to answer
 * it with, and the tally of what has been counted so far.
 *
 * The tap is a `pointerdown` (and `Space`/`Enter` for a keyboard that cannot
 * point): the moment the press begins is what is scored, and waiting for the
 * click would add the release to every reading. A press that answers no burst is
 * said out loud and costs nothing — the sound it missed is still there to hear.
 */
export function MeasureScreen({
  currentDevice,
  extending,
  round,
  failure,
  tapped,
  sloppy,
  deviceName,
  formatList,
  tap,
  tapRef,
  cancelRun,
  setStep,
  beginMeasure,
  retryNoPresses,
}: {
  currentDevice: string;
  extending: boolean;
  round: number;
  failure: MeasureFailure | null;
  tapped: number;
  sloppy: boolean;
  deviceName: (id: string) => string;
  formatList: (ids: string[]) => string;
  tap: () => void;
  /** The button itself: the dialog hands the keyboard here whenever a round is
   *  actually being answered, which is what makes `Space`/`Enter` tap. */
  tapRef: RefObject<HTMLButtonElement | null>;
  cancelRun: () => void;
  setStep: (step: Step) => void;
  beginMeasure: () => void;
  retryNoPresses: () => void;
}) {
  const { t } = useTranslation();
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={FADE}
      transformTemplate={MAIN_THREAD_TRANSFORM}
    >
      <p className="mt-2 text-[12px] text-text-secondary">
        {extending
          ? t('calibration.extensionRound', { r: round })
          : t('calibration.roundProgress', { r: round, n: MIN_ROUNDS })}
        {' · '}
        <span className="font-medium text-text-primary">
          {t('calibration.calibratingNow', { name: deviceName(currentDevice) })}
        </span>
      </p>

      {failure === null ? (
        <>
          <motion.button
            ref={tapRef}
            type="button"
            whileTap={{ scale: 0.985 }}
            transition={SPRING_TAP}
            transformTemplate={MAIN_THREAD_TRANSFORM}
            onPointerDown={tap}
            onKeyDown={(e) => {
              if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) tap();
            }}
            aria-label={t('calibration.tap')}
            className="mt-4 flex h-20 w-full items-center justify-center rounded-ctl border border-line bg-surface-raised text-[13px] font-medium text-text-secondary outline-none hover:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {t('calibration.tap')}
          </motion.button>
          <p className="mt-2 text-[11px] leading-relaxed text-text-muted">
            {t('calibration.tapTally', { n: tapped, need: MIN_VALID })}
          </p>
          {sloppy && (
            <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
              {t('calibration.sloppy')}
            </p>
          )}
        </>
      ) : (
        <div className="mt-4 rounded-ctl border border-line px-3 py-2.5">
          <p className="text-[11px] leading-relaxed text-text-secondary">
            {failure.message !== null
              ? t('calibration.failed', { error: failure.message })
              : t('calibration.noPresses', { devices: formatList(failure.noPresses) })}
          </p>
          <button
            type="button"
            onClick={failure.message !== null ? beginMeasure : retryNoPresses}
            className="pressable mt-2 flex items-center gap-1.5 rounded-ctl border border-line px-2.5 py-1 text-[11px] font-medium text-text-secondary outline-none hover:border-accent/50 hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {t('calibration.retry')}
          </button>
        </div>
      )}

      <div className="mt-5 flex items-center justify-end">
        <button
          type="button"
          onClick={() => {
            cancelRun();
            setStep('select');
          }}
          className="pressable rounded-ctl border border-line px-3 py-1.5 text-[11px] font-medium text-text-secondary outline-none hover:border-accent/50 hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          {t('calibration.cancel')}
        </button>
      </div>
    </motion.div>
  );
}
