import type { ReactNode } from 'react';

/** Round ± button shared by the delay controls. */
export function StepButton({
  label,
  disabled,
  onClick,
  size = 'md',
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  /** `sm` is the stage capsule, `md` the settings row. */
  size?: 'sm' | 'md';
  children: ReactNode;
}) {
  const box = size === 'sm' ? 'h-5 w-5' : 'h-6 w-6';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`flex ${box} flex-none items-center justify-center rounded-full text-text-secondary outline-none transition-colors hover:bg-accent-muted hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-default disabled:text-text-muted/40 disabled:hover:bg-transparent disabled:hover:text-text-muted/40`}
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
