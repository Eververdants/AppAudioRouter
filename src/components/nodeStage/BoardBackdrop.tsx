import { BOARD_W, HUB_W, HUB_X } from '@/lib/stage';
import type { WireSpec } from './shared';

/**
 * The halo behind the board. Pure hairline, `aria-hidden`, and behind every card
 * and every wire — it reports whose board this is and answers nothing else.
 */
export function Halo({ height }: { height: number }) {
  return (
    <>
      {/* The halo: the hub's own concentric rings, drawn into the well as
              line work. The interface's every indicator is two circles sharing
              a centre; here the same mark is scaled up until it is scenery —
              the plane declaring whose board this is without lighting, filling
              or shadowing anything. Pure hairline, behind every card and every
              wire. */}
      <svg
        aria-hidden="true"
        width={BOARD_W}
        height={height}
        className="pointer-events-none absolute inset-0"
      >
        {[96, 152, 208].map((r) => (
          <circle
            key={r}
            cx={HUB_X + HUB_W / 2}
            cy={height / 2}
            r={r}
            fill="none"
            stroke="var(--hairline-strong)"
            strokeWidth={1}
            opacity={0.45}
          />
        ))}
      </svg>
    </>
  );
}

/**
 * Every wire of the board, in one SVG layer.
 *
 * The endpoints were all computed by the board from `lib/stage.ts`, so a row and
 * the line meeting it cannot disagree by a frame. The flow class is the board's
 * one standing animation: a wire is `live` only for sound that is actually moving
 * *and* a gate (`useLiveness`) that is open, so a resting board paints nothing.
 */
export function WireLayer({
  wires,
  height,
  pid,
  devicesAnswered,
  lit,
}: {
  wires: WireSpec[];
  /** The board's height: the layer is the well, and every pin is on it. */
  height: number;
  pid: number | undefined;
  devicesAnswered: boolean;
  /** Whether the wire of this key is under the cursor. */
  lit: (key: string) => boolean;
}) {
  return (
    <>
      {/* The wires. One grey line each — the role colour lives on the rows
              (number badge, role word), not on the wire, so a fan of routes
              reads as plumbing rather than as spaghetti. */}
      <svg
        aria-hidden="true"
        width={BOARD_W}
        height={height}
        className="pointer-events-none absolute inset-0"
      >
        {wires.map((wire) => {
          // The draw-in is a proposal's own mark, so it is carried only
          // while the plan is not yet the route. A settled route that
          // merely went quiet — paused, or the window losing the gate — has
          // to fall back to the steady line: swapping `stage-flow` for
          // `stage-draw` restarts that keyframe, and every wire would then
          // redraw itself as though it had just been proposed. A staged
          // feed proposes on its own: it carries the draw-in until the hub
          // lands it, whatever the device half of the plan is doing.
          const proposed = wire.proposed ?? (!wire.live && !devicesAnswered);
          return (
            <path
              key={wire.key}
              data-wire={wire.key.startsWith('dev:') ? `${pid}:${wire.key.slice(4)}` : undefined}
              data-live={wire.live ? 'true' : undefined}
              d={wire.d}
              // A proposal wire draws itself once, out of the hub's pin; the
              // `pathLength` normalization is what lets one fixed dasharray
              // cover a path of any shape. A flowing wire never carries the
              // attribute — a normalized length would rescale the flow's own
              // dash pattern into a solid line — so it leaves the moment the
              // route lands, together with the class.
              pathLength={proposed ? 1 : undefined}
              // `live` is the route carrying sound right now, and that alone
              // is what the moving dash reports. `lit` is the cursor, and only
              // brightens the line: gating the flow on it made the animation
              // unreachable in the steady state it describes, because a wire
              // you are not hovering over was a still line even while playing.
              className={`nwire ${
                wire.live ? 'stage-flow' : proposed ? 'stage-draw' : ''
              } ${lit(wire.key) ? 'lit' : ''}`}
            />
          );
        })}
      </svg>
    </>
  );
}
