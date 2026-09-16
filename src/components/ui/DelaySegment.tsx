import { useTranslation } from 'react-i18next';
import { StepButton } from '@/components/ui/StepButton';
import { useDelayValue } from '@/hooks/useDelayValue';
import { useRouterStore } from '@/stores/routerStore';

/**
 * Delay control of one device, as a trailing segment of its node capsule.
 *
 * It is part of the chip rather than a second bubble floating under it, so a
 * device stays one object: the value shows inline once a delay is set, and the
 * −/value/+ stepper slides out of the same edge while the pointer is on the
 * chip (or the chip holds keyboard focus). With no delay set and no pointer on
 * it, the segment collapses to nothing and the stage is left with plain device
 * chips.
 *
 * The reveal is pure CSS (`group/device` on the node in `ConcentricRouter`):
 * both parts animate their max-width, so nothing is display-hidden and the
 * value field stays reachable from the keyboard.
 */
export function DelaySegment({
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

  /** The segment only opens while the node is hovered or holds focus. */
  const collapse = 'group-hover/device:max-w-0 group-focus-within/device:max-w-0';

  return (
    <div
      className={`flex min-w-0 flex-none items-center ${delaySync ? '' : 'opacity-60'}`}
      title={delaySync ? t('deviceDelay.valueLabel', { device: name }) : t('deviceDelay.syncOff')}
    >
      {/* Divider + value: open while a delay is set, sliding away as the
          stepper takes over. With no delay there is nothing to show, so it
          stays collapsed even on hover. */}
      <div
        className={`flex items-center overflow-hidden transition-[max-width] duration-200 ease-out ${
          committed === 0 ? 'max-w-0' : `max-w-[42px] ${collapse}`
        }`}
      >
        <span aria-hidden="true" className="mx-1.5 h-3 w-px flex-none bg-border" />
        <span className="pr-0.5 text-[10px] font-medium tabular-nums text-accent">{committed}</span>
      </div>

      {/* Stepper */}
      <div className="flex max-w-0 items-center overflow-hidden transition-[max-width] duration-200 ease-out group-hover/device:max-w-[72px] group-focus-within/device:max-w-[72px]">
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
          className="h-5 w-8 flex-none bg-transparent text-center text-[10px] font-medium tabular-nums text-accent outline-none"
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
