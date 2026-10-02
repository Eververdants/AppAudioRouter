import { useTranslation } from 'react-i18next';
import { NodePort } from '@/components/ui/NodePort';
import { NODE_H, SOURCE_W } from '@/lib/canvas';

/**
 * The program a route belongs to, drawn as the node the wires leave from.
 *
 * It is the one thing on the board that is not a decision — the app list already
 * chose it — so it has no hover state and no click: a card that highlights under
 * the pointer promises something the pointer can do. It carries a tooltip
 * instead, and that tooltip is where a first-time reader finds out that the
 * wires going right are this program's sound.
 *
 * The output port is the only place on the board where the concentric motif is
 * drawn three deep. It is the fan-out point — every wire starts here — so it is
 * the one port that gets to be a hub rather than a pin.
 */
export function SourceNode({ exeName, pid }: { exeName: string; pid: number }) {
  const { t } = useTranslation();

  return (
    <div className="relative" style={{ width: SOURCE_W, height: NODE_H }}>
      <div
        title={t('canvas.sourceHint')}
        className="flex h-full w-full flex-col justify-center rounded-[10px] border border-node-border bg-node px-3"
      >
        <h2 className="min-w-0 truncate text-[13px] font-medium text-text-primary">{exeName}</h2>
        <span className="font-mono text-[10px] tabular-nums text-text-muted">PID {pid}</span>
      </div>

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
    </div>
  );
}
