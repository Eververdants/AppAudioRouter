import type { ReactNode } from 'react';

/**
 * The ± button of the delay stepper: a hairline square.
 *
 * Flat rather than a filled circle, so it reads as a control belonging to the
 * field it steps rather than as a button standing on its own beside it.
 */
export function StepButton({
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
      className="pressable flex h-6 w-6 flex-none items-center justify-center rounded-full border border-line text-text-secondary outline-none hover:border-accent/50 hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-default disabled:opacity-40 disabled:hover:border-line disabled:hover:text-text-secondary"
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
