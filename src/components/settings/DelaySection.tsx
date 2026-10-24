import { type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { DelayRow } from '@/components/settings/DelayRow';
import { ROW_BUTTON_CLASS, Row } from '@/components/settings/Row';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { DELAY_STEP_OPTIONS, formatStep } from '@/lib/delay';
import type { AudioDevice } from '@/lib/types';
import { useRouterStore } from '@/stores/routerStore';

/**
 * Delay compensation, as the page's fourth section: the wizard's entry, the step
 * the −/+ buttons move by, and one row per device.
 *
 * This list is the place for a device that is not in any current route — the
 * board's tuning strip only reaches devices a route is actually using, and a
 * value set here is what the next route inherits.
 */
export function DelaySection({
  devices,
  setCalibrationOpen,
  calibrateButtonRef,
}: {
  devices: AudioDevice[];
  /** Opens the wizard. The page owns that state — it is an overlay above the
   *  paper, not a row of this section — and stands down its own Escape listener
   *  for as long as the wizard is open. */
  setCalibrationOpen: (open: boolean) => void;
  /** The opener, so the wizard can hand the keyboard back to the control that
   *  asked for it. */
  calibrateButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useTranslation();
  const delayStepMs = useRouterStore((s) => s.delayStepMs);
  const setDelayStep = useRouterStore((s) => s.setDelayStep);
  const devicesError = useRouterStore((s) => s.devicesError);
  const refreshDevices = useRouterStore((s) => s.refreshDevices);

  return (
    <>
      <Row title={t('settings.delayCalibrate')} desc={t('settings.delayCalibrateDesc')}>
        <div className="flex flex-col items-end gap-1.5">
          <button
            type="button"
            ref={calibrateButtonRef}
            onClick={() => setCalibrationOpen(true)}
            disabled={devices.length < 2}
            className={ROW_BUTTON_CLASS}
          >
            {t('settings.delayCalibrateAction')}
          </button>
          {/* A disabled control with no reason beside it is a dead end:
                        the walk needs two devices, and nothing on this row says
                        that the machine in front of the user has one. */}
          {devices.length < 2 && (
            <span className="max-w-[34ch] text-right text-[11px] leading-relaxed text-text-muted">
              {t('settings.delayCalibrateNeedsTwo')}
            </span>
          )}
        </div>
      </Row>
      <Row title={t('settings.delayStep')} desc={t('settings.delayStepDesc')}>
        <SegmentedControl
          layoutId="settings-delay-step"
          ariaLabel={t('settings.delayStep')}
          value={String(delayStepMs)}
          onChange={(value) => void setDelayStep(Number(value))}
          options={DELAY_STEP_OPTIONS.map((ms) => ({
            value: String(ms),
            label: formatStep(ms),
          }))}
        />
      </Row>
      <p className="border-b border-line py-3 text-[11px] leading-relaxed text-text-muted">
        {t('settings.delayNote')}
      </p>
      <p className="border-b border-line py-3 text-[11px] leading-relaxed text-text-muted">
        {t('settings.calibrationNote')}
      </p>
      {devices.length === 0 ? (
        devicesError === null ? (
          <p className="py-6 text-center text-[11px] text-text-muted">{t('settings.noDevices')}</p>
        ) : (
          // A read that refused is not a machine with no devices: the
          // two need different sentences, and the second needs a way
          // out of itself.
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <p className="text-[11px] text-text-secondary">{t('settings.devicesReadFailed')}</p>
            <p className="max-w-[46ch] text-xs leading-relaxed text-text-muted">{devicesError}</p>
            <button
              type="button"
              onClick={() => void refreshDevices()}
              className={ROW_BUTTON_CLASS}
            >
              {t('settings.retry')}
            </button>
          </div>
        )
      ) : (
        devices.map((device) => (
          <DelayRow key={device.id} deviceId={device.id} name={device.name} />
        ))
      )}
    </>
  );
}
