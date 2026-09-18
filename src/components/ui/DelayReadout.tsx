import { useTranslation } from 'react-i18next';
import { ScrubReadout } from '@/components/ui/ScrubReadout';
import { formatDelaySigned, formatStep } from '@/lib/delay';
import { useRouterStore } from '@/stores/routerStore';

/**
 * One device's delay compensation, annotated under its node capsule.
 *
 * The number is the control (see `ScrubReadout`); this wrapper only supplies
 * what a delay means: a signed value inside the configured range, stepped by
 * the configured amount, dimmed while delay sync is off.
 */
export function DelayReadout({
  deviceId,
  name,
  rangeMs,
}: {
  deviceId: string;
  name: string;
  rangeMs: number;
}) {
  const { t } = useTranslation();
  const delaySync = useRouterStore((s) => s.delaySync);
  const committed = useRouterStore((s) => s.deviceDelays[deviceId] ?? 0);
  const stepMs = useRouterStore((s) => s.delayStepMs);
  const setDeviceDelayValue = useRouterStore((s) => s.setDeviceDelayValue);

  const hint = t('deviceDelay.hint', { step: formatStep(stepMs) });

  return (
    <ScrubReadout
      value={committed}
      min={-rangeMs}
      max={rangeMs}
      step={stepMs}
      format={formatDelaySigned}
      unit="ms"
      label={t('deviceDelay.valueLabel', { device: name })}
      hint={delaySync ? hint : `${hint}\n${t('deviceDelay.syncOff')}`}
      neutral={committed === 0}
      dim={!delaySync}
      onCommit={(next) => void setDeviceDelayValue(deviceId, next)}
    />
  );
}
