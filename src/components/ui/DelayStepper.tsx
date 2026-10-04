import { useTranslation } from 'react-i18next';
import { StepButton } from '@/components/ui/StepButton';
import { useDelayValue } from '@/hooks/useDelayValue';

/**
 * Delay compensation control for one device in the settings list: a −/+ pair
 * stepping by the configured step, with a directly editable millisecond value
 * in between so an exact figure can be entered too.
 *
 * The settings page is the only place this control appears; the same delay is
 * also stepped from the disc it belongs to on the stage (`ConcentricStage`),
 * and both share the editing logic in `useDelayValue`.
 */
export function DelayStepper({
  deviceId,
  name,
  rangeMs,
}: {
  deviceId: string;
  name: string;
  rangeMs: number;
}) {
  const { t } = useTranslation();
  const { committed, draft, setDraft, commit, nudge, cancel, stepMs, stepLabel, atMin, atMax } =
    useDelayValue(deviceId, rangeMs);

  return (
    <div className="flex flex-none items-center gap-1">
      <StepButton
        label={t('deviceDelay.stepDown', { step: stepLabel })}
        disabled={atMin}
        onClick={() => nudge(-1)}
      >
        <line x1="1" y1="5" x2="9" y2="5" />
      </StepButton>
      <div className="flex h-6 items-center border-b border-line pr-1 transition-colors focus-within:border-accent/60">
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
          className="h-full w-[54px] bg-transparent text-right font-mono text-[11px] tabular-nums text-text-primary outline-none"
        />
        <span className="ml-0.5 font-mono text-[9px] leading-none text-text-muted">ms</span>
      </div>
      <StepButton
        label={t('deviceDelay.stepUp', { step: stepLabel })}
        disabled={atMax}
        onClick={() => nudge(1)}
      >
        <line x1="1" y1="5" x2="9" y2="5" />
        <line x1="5" y1="1" x2="5" y2="9" />
      </StepButton>
    </div>
  );
}
