import { useTranslation } from 'react-i18next';
import { StepButton } from '@/components/ui/StepButton';
import { useDelayValue } from '@/hooks/useDelayValue';
import { useRouterStore } from '@/stores/routerStore';

/**
 * `− / value / +` delay control for one device, as a small capsule.
 *
 * Lives on the router stage next to the device node it belongs to: a delay is a
 * property of the device, so it belongs with the device rather than in a
 * separate panel. The value stays typeable, so an exact figure can still be
 * entered.
 */
export function DelayCapsule({
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
  const { committed, draft, setDraft, commit, nudge, cancel, stepMs, stepLabel, atMin, atMax } =
    useDelayValue(deviceId, rangeMs);

  // A capsule under every device would crowd the stage, so it stays out of the
  // way until it is wanted: hovering or focusing the device (its node carries
  // the `group/device` class) reveals it, and any device that actually has a
  // delay keeps it visible so a set value is never hidden.
  const hidden = committed === 0;

  return (
    <div
      title={delaySync ? t('deviceDelay.valueLabel', { device: name }) : t('deviceDelay.syncOff')}
      className={`rounded-full border border-glass bg-glass-strong shadow-glass backdrop-blur-xl ${
        hidden
          ? 'pointer-events-none opacity-0 transition-opacity group-hover/device:pointer-events-auto group-hover/device:opacity-100 group-focus-within/device:pointer-events-auto group-focus-within/device:opacity-100'
          : 'opacity-100'
      }`}
    >
      {/* Opacity of the sync-off state lives on an inner wrapper so it never
          fights the reveal classes above for the same property. */}
      <div className={`flex items-center gap-0.5 px-0.5 py-px ${delaySync ? '' : 'opacity-60'}`}>
        <StepButton
          size="sm"
          label={t('deviceDelay.stepDown', { step: stepLabel })}
          disabled={atMin}
          onClick={() => nudge(-1)}
        >
          <line x1="1" y1="5" x2="9" y2="5" />
        </StepButton>
        <input
          type="number"
          inputMode="numeric"
          step={stepMs}
          min={-rangeMs}
          max={rangeMs}
          value={draft ?? String(committed)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              cancel();
              e.currentTarget.blur();
            }
          }}
          aria-label={t('deviceDelay.valueLabel', { device: name })}
          className={`h-5 w-10 bg-transparent text-center text-[10px] tabular-nums outline-none ${
            committed === 0 ? 'text-text-muted' : 'font-medium text-accent'
          }`}
        />
        <StepButton
          size="sm"
          label={t('deviceDelay.stepUp', { step: stepLabel })}
          disabled={atMax}
          onClick={() => nudge(1)}
        >
          <line x1="1" y1="5" x2="9" y2="5" />
          <line x1="5" y1="1" x2="5" y2="9" />
        </StepButton>
      </div>
    </div>
  );
}
