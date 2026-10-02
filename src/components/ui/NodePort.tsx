import type { NodeRole } from '@/lib/canvas';
import { TONE } from '@/lib/canvas';

/** Sizes are literal classes per state — see the note on `RoleTone` in
 *  `lib/canvas.ts` about class names that Tailwind cannot see. */
const RING_LIVE = 'h-3.5 w-3.5 border-2';
const RING_DORMANT = 'h-2.5 w-2.5 border';
const CORE_LIVE = 'h-[5px] w-[5px]';
const CORE_DORMANT = 'h-1 w-1';

/**
 * A node's port: two rings of one colour with the node's own fill showing
 * between them.
 *
 * The gap is what makes it read as concentric rather than as a dot with a
 * smudge around it, so the outer ring is a *border* on a transparent box rather
 * than a filled circle sitting underneath — nothing is painted in the space
 * between, and whatever the port is standing on shows through.
 *
 * `dormant` is the side nothing is plugged into. Blueprint nodes carry pins on
 * both edges and leave the unconnected ones dim; drawing only the connected
 * ones would make the two sides of the graph disagree about what a node is.
 */
export function NodePort({
  role,
  dormant = false,
  className = '',
}: {
  role: NodeRole;
  /** The side of the node nothing is plugged into: same shape, no signal. */
  dormant?: boolean;
  /** Placement, supplied by the node so the port can sit on its own edge. */
  className?: string;
}) {
  const tone = TONE[role];

  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute flex items-center justify-center rounded-full ${
        dormant ? `${RING_DORMANT} border-node-border` : `${RING_LIVE} ${tone.ring}`
      } ${className}`}
    >
      <span
        className={`rounded-full ${dormant ? `${CORE_DORMANT} bg-node-border` : `${CORE_LIVE} ${tone.core}`}`}
      />
    </span>
  );
}
