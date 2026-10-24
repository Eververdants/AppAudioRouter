import { ScrubReadout } from '@/components/ui/ScrubReadout';

/**
 * One figure in the strip, as the shared scrub control.
 *
 * The same number the settings page and the level ring read with: drag it,
 * wheel it, arrow-key it, or click it and type. The strip used to offer two
 * 16px ± buttons and nothing else — twenty clicks to take a copy from 100% to
 * silence, and a different vocabulary from every other figure in the app.
 */
export function StripValue({
  kind,
  label,
  title,
  value,
  min,
  max,
  step,
  format,
  unit,
  neutral,
  ariaLabel,
  stepLabels,
  onCommit,
}: {
  /** Which lever this is — the hook the specs address it by. */
  kind: 'primary' | 'delay' | 'share';
  label: string;
  title?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  unit: string;
  neutral: boolean;
  ariaLabel: string;
  stepLabels: { up: string; down: string };
  onCommit: (value: number) => void;
}) {
  return (
    <div data-strip-value={kind} className="flex items-center gap-2.5" title={title}>
      <span className="text-xs text-text-secondary">{label}</span>
      <ScrubReadout
        value={value}
        min={min}
        max={max}
        step={step}
        format={format}
        unit={unit}
        label={ariaLabel}
        hint={stepLabels.up}
        neutral={neutral}
        onCommit={onCommit}
      />
    </div>
  );
}
