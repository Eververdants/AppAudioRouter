import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { SPRING_TAP } from '@/lib/motion';

/**
 * How long an armed button waits before it forgets it was armed.
 *
 * Long enough to read the question and answer it, short enough that a button
 * nobody is looking at does not stay one click away from doing something the
 * user stopped thinking about.
 */
const CONFIRM_TIMEOUT_MS = 5000;

/** The settings-row / table-header shape: a word that asks once before it acts. */
const PILL_CLASS =
  'shrink-0 rounded-ctl border px-2.5 py-1 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 disabled:cursor-default disabled:opacity-45 disabled:hover:border-line disabled:hover:text-text-muted';
/** The process-list header shape: here the idle look is an icon, so the armed
 * state has to read as "this one is asking something" on its own. Icon buttons
 * are true circles — the same concentric mark every indicator wears. */
const ICON_CLASS =
  'mr-0.5 flex h-6 w-6 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error/50 disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-text-muted';

/** Drawn in place of an icon button's glyph once it is armed. */
const CONFIRM_GLYPH = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <polyline points="4 12.5 9.5 18 20 6" />
  </svg>
);

/**
 * A button that asks once before it acts.
 *
 * The first activation arms it and the second one fires; it disarms on Escape,
 * on blur, and after a few seconds on its own. It exists for the handful of
 * actions that reach every routed program at once, where a mis-click cannot be
 * finished off one row at a time — the window has no room for a dialog system,
 * and a destructive icon that asks in place is the whole of it.
 *
 * Keyboard and pointer take the same path: the armed state is announced through
 * the accessible name, so the second activation is never a surprise.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  icon,
  variant = 'pill',
  disabled = false,
}: {
  /** Idle label: the pill's text, and the accessible name of either variant. */
  label: string;
  /** What the button says once armed — the question the second click answers. */
  confirmLabel: string;
  onConfirm: () => void;
  /** Idle glyph of the `icon` variant; the armed state draws its own. */
  icon?: ReactNode;
  /** `pill` for a settings row, `icon` for the process list header. */
  variant?: 'pill' | 'icon';
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), CONFIRM_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);

  const asIcon = variant === 'icon';
  const className = asIcon
    ? `${ICON_CLASS} ${
        armed
          ? 'bg-error/10 text-error hover:bg-error/15'
          : 'text-text-muted hover:bg-error/10 hover:text-error'
      }`
    : `${PILL_CLASS} ${
        armed
          ? 'border-error/50 bg-error/10 text-error hover:bg-error/15 focus-visible:ring-error/50'
          : 'border-line text-text-secondary hover:border-accent/50 hover:text-accent focus-visible:ring-accent/60'
      }`;

  return (
    <motion.button
      type="button"
      disabled={disabled}
      // The question travels with the button, so a screen reader hears the same
      // thing the pointer reads in the tooltip.
      aria-label={armed ? confirmLabel : label}
      title={armed ? confirmLabel : label}
      whileHover={disabled || !asIcon ? undefined : { scale: 1.08 }}
      whileTap={disabled ? undefined : { scale: asIcon ? 0.9 : 0.96 }}
      transition={SPRING_TAP}
      onKeyDown={(event) => {
        // Escape disarms and goes no further: the key that answered this button
        // must not also close the page it sits on.
        if (armed && event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          setArmed(false);
        }
      }}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
      className={className}
    >
      {asIcon ? (armed ? CONFIRM_GLYPH : icon) : armed ? confirmLabel : label}
    </motion.button>
  );
}
