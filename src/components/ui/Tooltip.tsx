import type { ReactNode } from 'react';

/**
 * A hand-rolled tooltip for the labels that are too long for a `title`.
 *
 * Native tooltips are late, unstyleable and invisible to tests; this one is a
 * plain span that appears over its anchor once the pointer or the focus has
 * stayed a beat, and disappears the moment either leaves. It carries no
 * behaviour of its own — the anchor keeps its own accessible name, so screen
 * readers never depend on this being visible.
 *
 * Solid, and unapologetically so: a hint is not a panel, and the quickest way
 * to cheapen a flat surface is to give it a shadow and a blur it did not earn.
 */
export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="group/tip relative inline-flex">
      {children}
      {/* The delay lives on the *hover* state only: hovering past on the way
          somewhere else must not flash a bubble, but leaving shows no courtesy
          period — a tooltip that lingers reads as stuck. */}
      {label !== '' && (
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-0 z-40 mb-2 w-max max-w-[250px] translate-y-1 rounded-full bg-surface px-2.5 py-1.5 text-[11px] leading-relaxed text-text-secondary opacity-0 shadow-lg shadow-black/10 transition duration-150 group-focus-within/tip:translate-y-0 group-focus-within/tip:opacity-100 group-focus-within/tip:delay-300 group-hover/tip:translate-y-0 group-hover/tip:opacity-100 group-hover/tip:delay-300"
        >
          {label}
        </span>
      )}
    </span>
  );
}
