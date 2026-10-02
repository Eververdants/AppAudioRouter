import type { RoleTone } from '@/lib/canvas';

export type Wire = {
  key: string;
  /** The cubic Bézier between the two ports, in board pixels. */
  d: string;
  tone: RoleTone;
  /**
   * Whether the wire may flow: its program is sounding right now and the
   * window is in a state where motion may run at all (see `useLiveness`). A
   * flowing wire replaces its steady centre line with moving dashes — when
   * this is false the element is not there at all, so a resting board makes no
   * repaints.
   */
  live?: boolean;
};

/**
 * The wires, on one svg beneath the nodes.
 *
 * One layer rather than a line per node, because a wire belongs to neither of
 * the two nodes it joins and the geometry is already known — see the note on
 * the canvas geometry in `lib/canvas.ts` for why it is arithmetic instead of
 * measurement.
 *
 * Each wire is drawn twice: a wide, faint copy underneath and the wire itself
 * on top. That is the whole of the glow — no filter, no blur, nothing the GPU
 * has to composite again when the window is not even in front.
 *
 * A wire whose program is sounding *flows*: a third path of moving dashes
 * replaces the steady centre line, and the route reads as something moving
 * rather than a diagram of it. This is the interface's one persistent repaint
 * and it is gated hard — mounted only while the source is sounding and
 * `useLiveness` allows motion at all, unmounted (not paused) otherwise, so a
 * board at rest is as static as it was before the flow existed. The speed does
 * not track the level; that would need a per-frame level the engines do not
 * publish, and the wake-up cost of polling one would outprice the effect.
 */
export function EdgeLayer({ wires }: { wires: Wire[] }) {
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute left-0 top-0 h-full w-full"
      fill="none"
    >
      {wires.map((wire) => (
        <g key={wire.key} data-wire={wire.key} data-live={wire.live ? 'true' : undefined}>
          <path
            d={wire.d}
            className={wire.tone.wire}
            strokeWidth={6}
            strokeLinecap="round"
            opacity={0.14}
          />
          {wire.live ? (
            <path
              d={wire.d}
              className={`${wire.tone.wire} wire-flow`}
              strokeWidth={2.25}
              strokeLinecap="round"
            />
          ) : (
            <path d={wire.d} className={wire.tone.wire} strokeWidth={1.75} strokeLinecap="round" />
          )}
        </g>
      ))}
    </svg>
  );
}
