import type { ReactNode } from 'react';

/**
 * The settings-row button: the same shape as `ConfirmButton`'s pill, minus the
 * asking. Kept beside the components that use it so the two never drift into
 * looking like different kinds of control.
 */
export const ROW_BUTTON_CLASS =
  'pressable shrink-0 rounded-ctl border border-line px-2.5 py-1 text-[11px] font-medium text-text-secondary outline-none hover:border-accent/50 hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-default disabled:opacity-45 disabled:hover:border-line disabled:hover:text-text-secondary';

/** One setting: what it is on the left, the control that changes it on the
 * right, and a hairline under it to separate it from the next. */
export function Row({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line py-3.5 last:border-b-0">
      <div className="min-w-0">
        <div className="text-[13px] text-text-primary">{title}</div>
        {/* Capped at a reading measure: a description that runs to the width of
            the page would push the control it describes out to the far edge. */}
        {desc && (
          <div className="mt-1 max-w-[52ch] text-[11px] leading-relaxed text-text-muted">
            {desc}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}
