import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { MeasureScreen } from '@/components/calibration/MeasureScreen';
import { ResultScreen } from '@/components/calibration/ResultScreen';
import { SelectDevices } from '@/components/calibration/SelectDevices';
import { useCalibrationRun } from '@/components/calibration/hooks/useCalibrationRun';
import { useDialogKeys } from '@/components/calibration/hooks/useDialogKeys';
import { MAIN_THREAD_TRANSFORM, SPRING_GLIDE } from '@/lib/motion';
import type { AudioDevice } from '@/lib/types';
import { useRouterStore } from '@/stores/routerStore';

/**
 * The delay wizard: measure each device's real, audible latency by playing
 * short tones and letting the user tap the button once for every tone heard,
 * then write the difference between the slowest device and the rest as the
 * copies' compensation.
 *
 * The devices interleave: the wizard drives one burst per call and rotates
 * through them round by round, so the human reaction time sits inside every
 * measurement equally and whatever drifts over the session (warming up,
 * tiring) lands on every device alike instead of biasing whichever was
 * measured first. Nothing about a device's type is guessed. The slowest
 * measured device becomes the alignment baseline (the role the engine
 * requires of the primary: the OS plays it directly, and software delay can
 * only hold the others back), and each other device receives
 * `difference − base pipeline` — the pipeline the copy would carry anyway.
 * Tapping a row re-picks the baseline: the offsets are all relative to each
 * other, so that is arithmetic, never a re-measure.
 *
 * What stays in this file is the dialog itself: the surface that says
 * `aria-modal` and really takes the keyboard in, the three screens it hands to
 * the run's current step, which devices were checked before the run started,
 * and the names every screen speaks in. The measurement — the round-robin loop,
 * the taps it scores, the medians and the write — is `hooks/useCalibrationRun`;
 * the keys the dialog holds are `hooks/useDialogKeys`; the screens are
 * `SelectDevices`, `MeasureScreen` and `ResultScreen`, and the numbers the loop
 * is built from are in `constants.ts` beside them.
 */
export function DelayCalibration({
  devices,
  onClose,
}: {
  devices: AudioDevice[];
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    // Devices that carry a live route are the ones that need aligning; they
    // start checked so the common case is a single press of the start button.
    const routed = new Set(Object.values(useRouterStore.getState().routedPids).flat());
    return devices.filter((d) => routed.has(d.id)).map((d) => d.id);
  });

  /** The dialog surface, so the keyboard lands inside a modal rather than
   *  behind it: the page under this is unreachable while it runs, and the walk
   *  is a timed one — every second spent hunting for the button is a burst not
   *  heard. */
  const dialogRef = useRef<HTMLDivElement | null>(null);
  /** The tap target, so the measurement screen starts with the key on it. */
  const tapRef = useRef<HTMLButtonElement | null>(null);

  const {
    step,
    setStep,
    round,
    extending,
    currentDevice,
    tapped,
    sloppy,
    failure,
    baselineId,
    setBaselineId,
    applyFailed,
    setApplyFailed,
    applying,
    computed,
    beginMeasure,
    retryNoPresses,
    tap,
    cancelRun,
    apply,
  } = useCalibrationRun({ devices, selectedIds, onClose });

  // Every screen replaces the controls the focus was sitting on — 开始测量
  // unmounts, the failure panel and the tap button trade places — and a focused
  // element that leaves the DOM drops the caret to the document root, where the
  // next `Tab` walks straight out of a dialog that says `aria-modal`. So the
  // key is handed back to the dialog on each change of screen, and straight to
  // the tap button when a round is actually being answered (which is also what
  // makes `Space`/`Enter` tap, as the wizard promises).
  useEffect(() => {
    if (step === 'measure' && failure === null) tapRef.current?.focus();
    else dialogRef.current?.focus();
  }, [step, failure]);

  const deviceName = useCallback(
    (id: string) => devices.find((d) => d.id === id)?.name ?? t('calibration.deviceGone'),
    [devices, t],
  );

  const formatList = useCallback(
    (ids: string[]) =>
      new Intl.ListFormat(i18n.language, { type: 'unit' }).format(ids.map(deviceName)),
    [deviceName, i18n.language],
  );

  // A device unplugged while the wizard is open leaves its row, so it has to
  // leave the answer too: the two-device gate counts what is checked, and a
  // phantom in it would start a run that measures nothing and a result screen
  // that writes a number nothing can take. A run already going keeps the set it
  // started with — the baseline must not move under it.
  useEffect(() => {
    setSelectedIds((ids) => {
      const live = ids.filter((id) => devices.some((device) => device.id === id));
      return live.length === ids.length ? ids : live;
    });
  }, [devices]);

  // The dialog holds `Escape` (close, and stop the sound) and `Tab` (stay
  // inside) for as long as it is mounted; the settings page stands down for the
  // first while this is open.
  useDialogKeys({ dialogRef, cancelRun, onClose });

  const toggleDevice = (id: string) => {
    setSelectedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 outline-none"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delay-calibration-title"
      ref={dialogRef}
      tabIndex={-1}
    >
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={SPRING_GLIDE}
        transformTemplate={MAIN_THREAD_TRANSFORM}
        className="w-full max-w-md rounded-panel border border-line-strong bg-surface p-5"
      >
        <h2
          id="delay-calibration-title"
          className="text-[15px] font-semibold tracking-tight text-text-primary"
        >
          {t('calibration.title')}
        </h2>

        {step === 'select' && (
          <SelectDevices
            devices={devices}
            selectedIds={selectedIds}
            toggleDevice={toggleDevice}
            cancelRun={cancelRun}
            onClose={onClose}
            beginMeasure={beginMeasure}
          />
        )}

        {step === 'measure' && currentDevice !== null && (
          <MeasureScreen
            currentDevice={currentDevice}
            extending={extending}
            round={round}
            failure={failure}
            tapped={tapped}
            sloppy={sloppy}
            deviceName={deviceName}
            formatList={formatList}
            tap={tap}
            tapRef={tapRef}
            cancelRun={cancelRun}
            setStep={setStep}
            beginMeasure={beginMeasure}
            retryNoPresses={retryNoPresses}
          />
        )}

        {step === 'result' && computed !== null && baselineId !== null && (
          <ResultScreen
            computed={computed}
            baselineId={baselineId}
            deviceName={deviceName}
            applying={applying}
            applyFailed={applyFailed}
            setApplyFailed={setApplyFailed}
            setBaselineId={setBaselineId}
            beginMeasure={beginMeasure}
            apply={apply}
          />
        )}
      </motion.div>
    </div>
  );
}
