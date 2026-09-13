import type { ReactNode } from 'react';
import { motion } from 'framer-motion';

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
  /** Must be unique per control instance: it keys the shared sliding pill. */
  layoutId: string;
  ariaLabel?: string;
}

/**
 * Segmented control with a sliding accent pill behind the active option
 * (spring-animated via a shared layout id).
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
      className="flex flex-none items-center rounded-full border border-glass bg-glass-strong p-0.5"
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
            className={`relative flex h-7 items-center gap-1 rounded-full px-3 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60 ${
              active ? 'text-white' : 'text-text-muted hover:text-text-primary'
            }`}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                className="absolute inset-0 rounded-full bg-accent shadow-glow"
                transition={{ type: 'spring', stiffness: 500, damping: 32 }}
              />
            )}
            <span className="relative">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
