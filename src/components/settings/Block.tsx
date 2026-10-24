import type { ReactNode } from 'react';

/** A stacked block: a title, an explanation, then whatever the setting owns. */
export function Block({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: ReactNode;
}) {
  return (
    <div className="border-b border-line py-3.5 last:border-b-0">
      <div className="text-[13px] text-text-primary">{title}</div>
      {desc && (
        <div className="mt-1 max-w-[52ch] text-[11px] leading-relaxed text-text-muted">{desc}</div>
      )}
      <div className="mt-3">{children}</div>
    </div>
  );
}
