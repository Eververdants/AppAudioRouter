import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { DelayReadout } from '@/components/ui/DelayReadout';
import { NodePort } from '@/components/ui/NodePort';
import { VolumeReadout } from '@/components/ui/VolumeReadout';
import {
  DELAY_W,
  NAME_W,
  NODE_H,
  ROLE_W,
  TONE,
  VOLUME_W,
  deviceWidth,
  type NodeRole,
} from '@/lib/canvas';
import type { EngineRole } from '@/lib/engineRole';
import { SPRING_GLIDE, SPRING_TAP } from '@/lib/motion';

/**
 * One output device, drawn as a node.
 *
 * A card with a port on each edge: the left one is where the route arrives and
 * wears the device's colour, the right one is a pin nothing is plugged into,
 * dimmed — a blueprint node has pins on both sides and only some of them
 * connected, and drawing just the used ones would make the two sides of the
 * board disagree about what a node is.
 *
 * The card scales with a spring under the pointer but the *ports* do not: they
 * are siblings of the card rather than children of it, so a wire that meets a
 * port still meets it while the card is moving. The glow is a separate layer
 * faded in with opacity rather than a shadow animated on the card, because a
 * tone-coloured shadow has to be composed from the theme's channels at runtime
 * and opacity is the one property that costs nothing to animate.
 *
 * The delay and volume readouts sit *beside* the name button, never inside it:
 * a control inside a control cannot be reached reliably, least of all by
 * keyboard.
 */
export function DeviceNode({
  deviceId,
  name,
  role,
  engineRole,
  latencyMs,
  isDefaultDevice,
  advanced,
  delayRangeMs,
  pressed,
  onToggle,
}: {
  deviceId: string;
  name: string;
  role: NodeRole;
  engineRole: EngineRole;
  latencyMs: number | undefined;
  isDefaultDevice: boolean;
  advanced: boolean;
  delayRangeMs: number;
  /** Whether the device is staged for the pending route — the button's
   *  `aria-pressed`, and the same fact the amber wash is saying. */
  pressed: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const tone = TONE[role];

  const roleLabel =
    role === 'primary'
      ? t('router.rolePrimary')
      : role === 'mirror'
        ? t('router.roleMirror')
        : role === 'staged'
          ? t('router.pending')
          : '—';

  // What the role word means, in words. The colours carry the encoding; this is
  // for the reader who has not met one of them before, and for whom "Mirror" is
  // not yet a thing they can act on.
  const roleHint =
    role === 'primary'
      ? t('canvas.rolePrimaryHint')
      : role === 'mirror'
        ? t('canvas.roleMirrorHint')
        : role === 'staged'
          ? t('canvas.roleStagedHint')
          : t('canvas.roleIdleHint');

  return (
    <motion.div
      layout
      transition={SPRING_GLIDE}
      data-device-row={deviceId}
      className="group/node relative"
      style={{ width: deviceWidth(advanced), height: NODE_H }}
    >
      <motion.div
        whileHover={{ scale: 1.02 }}
        transition={SPRING_TAP}
        className={`relative flex h-full w-full items-center rounded-[10px] border bg-node ${tone.outline} ${tone.wash}`}
      >
        {/* The bloom. `idle` gets none until the pointer arrives: most devices
            are idle most of the time, and a board where everything glows is a
            board where the glow says nothing. */}
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute -inset-1 rounded-[13px] transition-opacity duration-150 ${
            role === 'idle'
              ? 'opacity-0 group-hover/node:opacity-70'
              : 'opacity-70 group-hover/node:opacity-100'
          }`}
          style={{ boxShadow: `0 0 26px -8px rgb(var(${tone.glow}) / 0.5)` }}
        />

        <button
          type="button"
          onClick={onToggle}
          aria-pressed={pressed}
          aria-label={name}
          title={name}
          style={{ width: NAME_W }}
          className="flex h-full min-w-0 flex-none flex-col justify-center rounded-l-[10px] pl-3 pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
        >
          <span
            className={`w-full min-w-0 truncate text-[13px] ${
              role === 'idle' ? 'text-text-secondary' : 'text-text-primary'
            }`}
          >
            {name}
          </span>
          {/* Which device Windows would use if nothing were routed is a fact
              about the device, so it is written under the name in the same muted
              type the app list uses for its second line — not as a bordered
              badge, which would be the only box on a board of nodes, and not
              after the name on the same line either, where it would eat enough
              of the cell to truncate the name it is describing.
              The line is reserved whether or not there is anything on it: the
              one node that is the system default would otherwise push its own
              name half a line up, and six names down a column that do not share
              a baseline read as a mistake. */}
          <span
            className="w-full min-w-0 truncate text-[10px] text-text-muted"
            style={{ minHeight: 13 }}
            title={isDefaultDevice ? t('router.defaultDevice') : undefined}
          >
            {isDefaultDevice ? t('router.defaultLabel') : null}
          </span>
        </button>

        <span
          style={{ width: ROLE_W }}
          title={roleHint}
          className={`flex-none truncate text-[11px] ${tone.label} ${advanced ? '' : 'pr-3'}`}
        >
          {roleLabel}
        </span>

        {advanced && (
          <>
            <span style={{ width: DELAY_W }} className="flex flex-none items-center justify-end">
              <DelayReadout
                deviceId={deviceId}
                name={name}
                rangeMs={delayRangeMs}
                engineRole={engineRole}
                latencyMs={latencyMs}
              />
            </span>
            <span
              style={{ width: VOLUME_W }}
              className="flex flex-none items-center justify-end pr-3"
            >
              <VolumeReadout deviceId={deviceId} name={name} engineRole={engineRole} />
            </span>
          </>
        )}
      </motion.div>

      <NodePort role={role} className="left-0 top-1/2 -translate-x-1/2 -translate-y-1/2" />
      <NodePort role={role} dormant className="right-0 top-1/2 translate-x-1/2 -translate-y-1/2" />
    </motion.div>
  );
}
