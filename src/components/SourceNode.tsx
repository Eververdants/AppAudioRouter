import type { MouseEvent } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { NodePort } from '@/components/ui/NodePort';
import { NODE_H, SOURCE_W, TONE } from '@/lib/canvas';
import { SPRING_TAP } from '@/lib/motion';

/**
 * One program whose sound goes somewhere, drawn as the node its wires leave
 * from.
 *
 * There is one of these per routed program, not one for "the" program: the
 * point of the board is to see where every sound is going at once, so the
 * sources are a column the way the devices are. The program being routed — the
 * selection — is the one drawn louder: a heavier outline and the route-coloured
 * bloom, the same treatment a device gets when a route involves it.
 *
 * Clicking one makes it the subject, exactly as clicking its row in the app
 * list does. That is a real decision the pointer can make, so the node takes a
 * hover state; it did not when the board showed only the selected program and
 * the click would have been a lie.
 *
 * The output port is the only place on the board where the concentric motif is
 * drawn three deep. It is the fan-out point — every wire starts here — so it is
 * the one port that gets to be a hub rather than a pin.
 */
export function SourceNode({
  exeName,
  pid,
  selected,
  onSelect,
}: {
  exeName: string;
  pid: number;
  /** Whether this program is what the routing question is currently about. */
  selected: boolean;
  /** Receives the pointer event so the owner can honour Ctrl+click the same
   *  way the app list does. */
  onSelect: (event: MouseEvent) => void;
}) {
  const { t } = useTranslation();

  return (
    <motion.div
      whileHover={{ scale: 1.02 }}
      transition={SPRING_TAP}
      data-source-node={exeName}
      className="group/source relative"
      style={{ width: SOURCE_W, height: NODE_H }}
    >
      {/* The bloom, on its own layer like the device nodes': opacity is the one
          property that costs nothing to animate, and a tone-coloured shadow has
          to be composed from the theme's channels at runtime. */}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute -inset-1 rounded-[13px] transition-opacity duration-150 ${
          selected ? 'opacity-70' : 'opacity-0 group-hover/source:opacity-70'
        }`}
        style={{ boxShadow: `0 0 26px -8px rgb(var(${TONE.primary.glow}) / 0.5)` }}
      />
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        title={`${t('canvas.sourceHint')}\n${t('canvas.sourceSelectHint')}`}
        className={`flex h-full w-full flex-col justify-center rounded-[10px] border bg-node px-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 ${
          selected ? 'border-type-primary/50' : 'border-node-border'
        }`}
      >
        <span className="min-w-0 truncate text-[13px] font-medium text-text-primary">
          {exeName}
        </span>
        <span className="font-mono text-[10px] tabular-nums text-text-muted">PID {pid}</span>
      </button>

      {/* Nothing feeds the program: the left pin exists so the node reads as a
          node, not so it could be wired to something. */}
      <NodePort role="idle" dormant className="left-0 top-1/2 -translate-x-1/2 -translate-y-1/2" />

      <span
        aria-hidden="true"
        className="pointer-events-none absolute right-0 top-1/2 flex -translate-y-1/2 translate-x-1/2 items-center justify-center rounded-full border border-accent/40 p-[3px]"
      >
        <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full border-2 border-accent">
          <span className="h-[5px] w-[5px] rounded-full bg-accent" />
        </span>
      </span>
    </motion.div>
  );
}
