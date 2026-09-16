import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { clampDelay, formatStep, stepDelay } from '@/lib/delay';
import { useRouterStore } from '@/stores/routerStore';

/** Round ± stepper button. */
function StepButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="flex h-6 w-6 flex-none items-center justify-center rounded-md border border-border bg-bg-secondary/60 text-text-secondary outline-none transition-colors hover:border-accent/60 hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-default disabled:border-border disabled:text-text-muted/50 disabled:hover:border-border disabled:hover:text-text-muted/50"
    >
      <svg
        width="9"
        height="9"
        viewBox="0 0 10 10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        aria-hidden="true"
      >
        {children}
      </svg>
    </button>
  );
}

/**
 * Delay compensation control for one device: a −/+ pair stepping by the
 * configured step, with a directly editable millisecond value in between so an
 * exact figure can be entered too.
 *
 * Values are written through the store, which applies them optimistically,
 * persists them, and rolls them back if the backend rejects them.
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
  const committed = useRouterStore((s) => s.deviceDelays[deviceId] ?? 0);
  const stepMs = useRouterStore((s) => s.delayStepMs);
  const setDeviceDelayValue = useRouterStore((s) => s.setDeviceDelayValue);
  /** Text being typed; `null` while the field mirrors the committed value. */
  const [draft, setDraft] = useState<string | null>(null);
  /** Set by Escape so the blur it triggers reverts instead of committing. */
  const reverting = useRef(false);

  const commit = () => {
    const raw = draft;
    setDraft(null);
    if (reverting.current) {
      reverting.current = false;
      return;
    }
    if (raw === null) return;
    const parsed = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(parsed)) return;
    void setDeviceDelayValue(deviceId, clampDelay(parsed, rangeMs));
  };

  const nudge = (direction: 1 | -1) => {
    const raw = draft;
    setDraft(null);
    // Clicking a step button blurs the field first, which commits whatever was
    // typed; step from that value so the click never discards the edit.
    const parsed = raw !== null && raw.trim() !== '' ? Number(raw) : Number.NaN;
    const base = Number.isFinite(parsed) ? parsed : committed;
    void setDeviceDelayValue(deviceId, stepDelay(base, direction, rangeMs, stepMs));
  };

  const stepLabel = formatStep(stepMs);

  return (
    <div className="flex flex-none items-center gap-1">
      <StepButton
        label={t('delayPanel.stepDown', { step: stepLabel })}
        disabled={committed <= -rangeMs}
        onClick={() => nudge(-1)}
      >
        <line x1="1" y1="5" x2="9" y2="5" />
      </StepButton>
      <div className="flex h-6 items-center rounded-md border border-border bg-bg-secondary/60 pr-1.5 transition-colors focus-within:border-accent/60">
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
              reverting.current = true;
              e.currentTarget.blur();
            }
          }}
          aria-label={t('delayPanel.valueLabel', { device: name })}
          className="h-full w-[54px] bg-transparent text-right text-[11px] tabular-nums text-text-primary outline-none"
        />
        <span className="ml-0.5 text-[9px] leading-none text-text-muted">ms</span>
      </div>
      <StepButton
        label={t('delayPanel.stepUp', { step: stepLabel })}
        disabled={committed >= rangeMs}
        onClick={() => nudge(1)}
      >
        <line x1="1" y1="5" x2="9" y2="5" />
        <line x1="5" y1="1" x2="5" y2="9" />
      </StepButton>
    </div>
  );
}
