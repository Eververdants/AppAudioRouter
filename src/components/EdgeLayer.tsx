import type { RoleTone } from '@/lib/canvas';

export type Wire = {
  key: string;
  /** The cubic Bézier between the two ports, in board pixels. */
  d: string;
  tone: RoleTone;
};

/**
 * The wires, on one svg beneath the nodes.
 *
 * One layer rather than a line per node, because a wire belongs to neither of
 * the two nodes it joins and the geometry is already known — see the note on
 * the canvas geometry in `lib/canvas.ts` for why it is arithmetic instead of
 * measurement.
 *
 * Nothing here animates. A marching dash would be the obvious way to say the
 * route is alive, and it would also be a repaint on every frame of the rest of
 * the session: the wires are already coloured by what they carry, and the port
 * they arrive at is already ringed in the same colour. The route is legible
 * standing still, so it stands still.
 *
 * Each wire is drawn twice: a wide, faint copy underneath and the wire itself
 * on top. That is the whole of the glow — no filter, no blur, nothing the GPU
 * has to composite again when the window is not even in front.
 */
export function EdgeLayer({ wires }: { wires: Wire[] }) {
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute left-0 top-0 h-full w-full"
      fill="none"
    >
      {wires.map((wire) => (
        <g key={wire.key}>
          <path
            d={wire.d}
            className={wire.tone.wire}
            strokeWidth={6}
            strokeLinecap="round"
            opacity={0.14}
          />
          <path d={wire.d} className={wire.tone.wire} strokeWidth={1.75} strokeLinecap="round" />
        </g>
      ))}
    </svg>
  );
}
