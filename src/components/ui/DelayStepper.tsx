import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { StepButton } from '@/components/ui/StepButton';
import { useDelayValue } from '@/hooks/useDelayValue';

/**
 * Delay compensation control for one device in the settings list: a −/+ pair
 * stepping by the configured step, with a directly editable millisecond value
 * in between so an exact figure can be entered too.
 *
 * The settings page is the only place this control appears; the board's tuning
 * dock steps the same delay through `setDeviceDelayValue` itself.
 *
 * Its rows happen to be keyed by device, and nothing here may depend on that.
 * A draft belongs to the device it was typed for and `useDelayValue` holds that
 * binding — every write goes to the draft's own device, and a draft from another
 * one is invisible to this field — so a row that re-renders under a different
 * `deviceId` cannot hand device A's typed number to device B. The invariant is
 * the hook's and `useDelayValue.test.tsx` carries it, so there is no second
 * guard here to keep in step.
 */
export function DelayStepper({ deviceId, name }: { deviceId: string; name: string }) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { committed, draft, setDraft, commit, nudge, cancel, stepMs, stepLabel, atMin, atMax } =
    useDelayValue(deviceId);

  return (
    <div
      ref={hostRef}
      // Not a tab stop, only a place to hand the focus to: the row's own −/+/field
      // controls stay in order, and `Escape` from the field leaves the caret here
      // rather than at the top of the document.
      tabIndex={-1}
      className="flex flex-none items-center gap-1 outline-none"
    >
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
          value={draft ?? String(committed)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            // Enter writes and the caret stays put: blurring would hand the focus
            // to the page, and the next Tab would start again at the top of the
            // window instead of here.
            if (e.key === 'Enter') {
              commit();
              return;
            }
            if (e.key === 'Escape') {
              // Escape abandons the draft, then leaves the field — the same
              // bargain `ScrubReadout` strikes: the first press belongs to the
              // control, the next one to the page. Staying here forever would
              // make the settings page unclosable and a standing toast
              // undismissable for as long as the caret sat in this number,
              // because both listeners stand down for an editable target.
              //
              // ⚠️ `cancel()` only marks the edit abandoned; the blur that the
              // focus move fires is what discards it. Committing here as well
              // would run the abandonment twice — and the second one, from this
              // same render's closure (the cleared draft has not re-rendered
              // yet), would write back the number Escape was meant to drop.
              cancel();
              hostRef.current?.focus();
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
