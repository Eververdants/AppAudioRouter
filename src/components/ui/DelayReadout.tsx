import { useTranslation } from 'react-i18next';
import { ScrubReadout } from '@/components/ui/ScrubReadout';
import { formatDelaySigned, formatStep } from '@/lib/delay';
import type { EngineRole } from '@/components/DeviceAnnotation';
import { useRouterStore } from '@/stores/routerStore';

/**
 * One device's delay compensation, annotated under its node capsule.
 *
 * The number is the control (see `ScrubReadout`); this wrapper only supplies
 * what a delay means: a signed value inside the configured range, stepped by
 * the configured amount, dimmed while delay sync is off or while no engine
 * path would apply it at all.
 */
export function DelayReadout({
  deviceId,
  name,
  rangeMs,
  engineRole,
}: {
  deviceId: string;
  name: string;
  rangeMs: number;
  engineRole: EngineRole;
}) {
  const { t } = useTranslation();
  const delaySync = useRouterStore((s) => s.delaySync);
  const committed = useRouterStore((s) => s.deviceDelays[deviceId] ?? 0);
  const stepMs = useRouterStore((s) => s.delayStepMs);
  const setDeviceDelayValue = useRouterStore((s) => s.setDeviceDelayValue);

  const hint = t('deviceDelay.hint', { step: formatStep(stepMs) });
  // The most specific reason wins: sync off beats "not in a route", which
  // beats the primary's anchor-only caveat.
  let notice: string | null = null;
  if (!delaySync) notice = t('deviceDelay.syncOff');
  else if (engineRole === 'inactive') notice = t('deviceDelay.inactive');
  else if (engineRole === 'primary') notice = t('deviceDelay.primary');

  return (
    <ScrubReadout
      value={committed}
      min={-rangeMs}
      max={rangeMs}
      step={stepMs}
      format={formatDelaySigned}
      unit="ms"
      label={t('deviceDelay.valueLabel', { device: name })}
      hint={notice ? `${hint}\n${notice}` : hint}
      neutral={committed === 0}
      dim={!delaySync || engineRole === 'inactive'}
      onCommit={(next) => void setDeviceDelayValue(deviceId, next)}
    />
  );
}
