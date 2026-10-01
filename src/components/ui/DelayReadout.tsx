import { useTranslation } from 'react-i18next';
import { ScrubReadout } from '@/components/ui/ScrubReadout';
import { formatDelaySigned, formatStep } from '@/lib/delay';
import type { EngineRole } from '@/lib/engineRole';
import { useRouterStore } from '@/stores/routerStore';

/**
 * One device's delay compensation, in the table's delay cell.
 *
 * The number is the control (see `ScrubReadout`); this wrapper only supplies
 * what a delay means: a signed value inside the configured range, stepped by
 * the configured amount, dimmed while no engine path would apply it at all.
 */
export function DelayReadout({
  deviceId,
  name,
  rangeMs,
  engineRole,
  latencyMs,
}: {
  deviceId: string;
  name: string;
  rangeMs: number;
  engineRole: EngineRole;
  /** What the endpoint reports back, when a running engine is filling it. */
  latencyMs?: number;
}) {
  const { t } = useTranslation();
  const committed = useRouterStore((s) => s.deviceDelays[deviceId] ?? 0);
  const stepMs = useRouterStore((s) => s.delayStepMs);
  const setDeviceDelayValue = useRouterStore((s) => s.setDeviceDelayValue);

  // The most specific reason wins: "not in a route" beats the primary's
  // anchor-only caveat.
  let notice: string | null = null;
  if (engineRole === 'inactive') notice = t('deviceDelay.inactive');
  else if (engineRole === 'primary') notice = t('deviceDelay.primary');

  // The tooltip is where the reading lives. Printed beside the setting it read
  // as one broken number — "+180 ms" and "20 ms" a few pixels apart — and it is
  // the one number in this cell nobody can act on, so it belongs where the
  // other things nobody can act on already are.
  const lines = [t('deviceDelay.hint', { step: formatStep(stepMs) })];
  if (notice !== null) lines.push(notice);
  if (latencyMs !== undefined) lines.push(t('deviceLatency.reading', { ms: latencyMs }));

  return (
    <ScrubReadout
      value={committed}
      min={-rangeMs}
      max={rangeMs}
      step={stepMs}
      format={formatDelaySigned}
      unit="ms"
      label={t('deviceDelay.valueLabel', { device: name })}
      hint={lines.join('\n')}
      neutral={committed === 0}
      dim={engineRole === 'inactive'}
      onCommit={(next) => void setDeviceDelayValue(deviceId, next)}
    />
  );
}
