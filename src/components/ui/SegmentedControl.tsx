import { useRef, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { SPRING_GLIDE } from '@/lib/motion';

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
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedIndex = options.findIndex((option) => option.value === value);
  // The seat the arrows start from. A value that names none of the segments (a
  // stored preference the list no longer offers) starts on the same segment that
  // holds the tab stop, so the walk begins where the focus actually is.
  const seat = selectedIndex < 0 ? 0 : selectedIndex;

  const move = (delta: number) => {
    const next = options[(seat + delta + options.length) % options.length];
    if (next === undefined) return;
    onChange(next.value);
    // The group is one tab stop and the arrows move inside it, so the focus has
    // to follow the selection: `aria-checked` alone would leave the ring on the
    // segment the arrows just moved away from.
    rootRef.current?.querySelector<HTMLButtonElement>(`[data-segment="${next.value}"]`)?.focus();
  };

  return (
    <div
      ref={rootRef}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={(event) => {
        // `role=radiogroup` promises the arrows the same way `role=tablist`
        // does; a radio that answers nothing is a control the keyboard was told
        // exists and cannot actually reach.
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault();
          move(1);
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault();
          move(-1);
        } else if (event.key === 'Home' || event.key === 'End') {
          const edge = event.key === 'Home' ? options[0] : options[options.length - 1];
          if (edge === undefined) return;
          event.preventDefault();
          onChange(edge.value);
          rootRef.current
            ?.querySelector<HTMLButtonElement>(`[data-segment="${edge.value}"]`)
            ?.focus();
        }
      }}
      className="flex flex-none items-center gap-4 border-b border-line"
    >
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            data-segment={option.value}
            aria-checked={active}
            aria-label={option.ariaLabel}
            // Roving tab stop: Tab enters the group at the chosen segment and
            // leaves it again, the way every other radio group behaves.
            //
            // ⚠️ A value that matches none of them must still leave one stop
            // standing: with `-1` on every segment the whole control drops out of
            // the tab order, and the keyboard cannot reach a setting it is
            // promised. The first segment takes the key in that case.
            tabIndex={index === seat ? 0 : -1}
            onClick={() => onChange(option.value)}
            className="group/seg relative flex flex-col justify-end outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
          >
            <span
              className={`flex items-center gap-1 px-0.5 pb-1 text-[11px] transition-[color,transform] duration-100 group-active/seg:scale-95 ${
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
                // The same curve the tab rows use for the same travelling
                // rule: a mark that migrates between labels is "visible
                // travel", not a press.
                transition={SPRING_GLIDE}
                className="absolute inset-x-0 bottom-0 h-0.5 bg-accent"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
