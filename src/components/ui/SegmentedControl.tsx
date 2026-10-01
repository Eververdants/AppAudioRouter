import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { SPRING_TAP } from '@/lib/motion';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Accessible name, used when the label is only an icon. */
  ariaLabel?: string;
}

interface SegmentedControlProps<T extends string> {
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  /** Must be unique per control instance: it keys the shared sliding rule. */
  layoutId: string;
  ariaLabel?: string;
}

/**
 * Segments separated by a rule, not a pill sliding in a track.
 *
 * A few mutually exclusive choices behave like a row of tabs in a settings
 * page, so they look like one: words with a rule under the chosen one. That
 * keeps the accent meaning "selected" everywhere in the app, instead of
 * meaning "selected" here and "pressable" in the list beside it — which is what
 * an accent-filled pill does when the buttons next to it are plain.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  layoutId,
  ariaLabel,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="flex flex-none items-center gap-4 border-b border-line"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={option.ariaLabel}
            onClick={() => onChange(option.value)}
            className="relative flex flex-col justify-end outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
          >
            <span
              className={`flex items-center gap-1 px-0.5 pb-1 text-[11px] transition-colors ${
                active
                  ? 'font-medium text-text-primary'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              {option.label}
            </span>
            {active && (
              <motion.span
                layoutId={layoutId}
                transition={SPRING_TAP}
                className="absolute inset-x-0 bottom-0 h-0.5 bg-accent"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
