import { useTranslation } from 'react-i18next';
import { StepButton } from '@/components/ui/StepButton';
import { useDelayValue } from '@/hooks/useDelayValue';
import { useRouterStore } from '@/stores/routerStore';

/**
 * Collapse/expand of one segment through the `0fr` → `1fr` grid trick: the
 * column is exactly as wide as its content, so a segment never reserves a
 * hard-coded budget it does not need. It animates just as well as a max-width
 * transition, and unlike `display` toggling it keeps the value field in the
 * tab order.
 */
const COLLAPSED = 'grid-cols-[0fr]';
const EXPANDED = 'grid-cols-[1fr]';

/**
 * Delay control of one device, as a trailing segment of its node capsule.
 *
 * It is part of the chip rather than a second bubble floating under it, so a
 * device stays one object: the value shows inline once a delay is set, and the
 * −/value/+ stepper slides out of the same edge while the pointer is on the
 * chip (or the chip holds keyboard focus). With no delay set and no pointer on
 * it, the segment collapses to nothing and the stage is left with plain device
 * chips. Widths are content-driven throughout — a value of `10` takes the room
 * `10` needs, not the room `-5000` would — and the only fixed number left is
 * the value field itself, because a number input's intrinsic width is a
 * browser default of about twenty characters.
 *
 * The reveal is pure CSS (`group/device` on the node in `ConcentricRouter`).
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

  return (
    <div
      className={`flex min-w-0 flex-none items-center ${delaySync ? '' : 'opacity-60'}`}
      title={delaySync ? t('deviceDelay.valueLabel', { device: name }) : t('deviceDelay.syncOff')}
    >
      {/* Divider + value: open while a delay is set, sliding away as the
          stepper takes over. With no delay there is nothing to show, so it
          stays collapsed even on hover. */}
      <div
        className={`grid overflow-hidden transition-[grid-template-columns] duration-200 ease-out ${
          committed === 0
            ? COLLAPSED
            : `${EXPANDED} group-hover/device:grid-cols-[0fr] group-focus-within/device:grid-cols-[0fr]`
        }`}
      >
        <div className="flex min-w-0 items-center overflow-hidden whitespace-nowrap">
          <span aria-hidden="true" className="mx-1.5 h-3 w-px flex-none bg-border" />
          <span className="pr-0.5 text-[10px] font-medium tabular-nums text-accent">
            {committed}
          </span>
        </div>
      </div>

      {/* Stepper */}
      <div
        className={`grid overflow-hidden transition-[grid-template-columns] duration-200 ease-out ${COLLAPSED} group-hover/device:grid-cols-[1fr] group-focus-within/device:grid-cols-[1fr]`}
      >
        <div className="flex min-w-0 items-center overflow-hidden">
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
    </div>
  );
}
