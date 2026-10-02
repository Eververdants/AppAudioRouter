import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { DeviceNode } from '@/components/DeviceNode';
import { EdgeLayer, type Wire } from '@/components/EdgeLayer';
import { SourceNode } from '@/components/SourceNode';
import { ConfirmButton } from '@/components/ui/ConfirmButton';
import {
  BOARD_PAD,
  COLUMN_GAP,
  DELAY_W,
  HEAD_H,
  NAME_W,
  NODE_GAP,
  NODE_H,
  ROLE_W,
  SOURCE_W,
  TONE,
  VOLUME_W,
  deviceWidth,
  roleOf,
  wirePath,
} from '@/lib/canvas';
import { activeDeviceIds, engineRolesFor } from '@/lib/engineRole';
import { useRouterStore } from '@/stores/routerStore';

/**
 * The routing screen: a node graph of one program and the devices its sound
 * goes to.
 *
 * Why a graph and not the table this replaced. The table said the same four
 * things — which device, what the route does with it, its delay, its volume —
 * and the ordering rule carried the rest: the route sorted to the top and a
 * heavier rule closed the block, so the leading rows *were* the route. That
 * works, and it reads as a list. It does not read as *flow*. The one thing a
 * table cannot draw is the thing this screen is about — that something is going
 * somewhere — and the four column headings spent a whole line of the window
 * explaining a shape the eye could have had for free.
 *
 * So: one source node on the left, one node per device on the right, and a
 * Bézier per device in the route. The ordering rule survives — the devices in
 * the route are still the leading ones, top to bottom in route order, which is
 * also the order the wires fan out in. The heading row survives too, aligned to
 * the node's own internal columns, because delay and volume are two numbers a
 * few pixels apart and unlabelled numbers are a puzzle.
 *
 * What is deliberately *not* here: no free-dragging, no pan, no zoom, no
 * marching dashes. Node positions come from the route order, which means the
 * wires are arithmetic rather than measurement (see `lib/canvas.ts`), which
 * means nothing has to be tracked across a layout pass — and a canvas of six
 * nodes has nothing to explore anyway. Pan and zoom are how you find something
 * you cannot see; the whole board fits, so there is nothing to find. The
 * fan-out *is* the animation budget: when a device joins the route its node
 * travels on a spring and its wire arrives with it.
 */
export function RouteCanvas() {
  const { t } = useTranslation();
  const sessions = useRouterStore((s) => s.sessions);
  const devices = useRouterStore((s) => s.devices);
  const selectedPids = useRouterStore((s) => s.selectedPids);
  const selectedDeviceIds = useRouterStore((s) => s.selectedDeviceIds);
  const routedPids = useRouterStore((s) => s.routedPids);
  const defaultDeviceId = useRouterStore((s) => s.defaultDeviceId);
  const delayRangeMs = useRouterStore((s) => s.delayRangeMs);
  const deviceLatencyMs = useRouterStore((s) => s.deviceLatencyMs);
  const advancedMode = useRouterStore((s) => s.advancedMode);
  const toggleDeviceSelection = useRouterStore((s) => s.toggleDeviceSelection);
  const stopRoute = useRouterStore((s) => s.stopRoute);
  const stopAllRoutes = useRouterStore((s) => s.stopAllRoutes);

  const activeIds = activeDeviceIds(selectedPids, routedPids);
  const engineRoles = engineRolesFor(routedPids);
  const routedCount = Object.keys(routedPids).length;

  const primaryPid = selectedPids[0];
  const primarySession =
    primaryPid === undefined ? undefined : sessions.find((s) => s.pid === primaryPid);

  // The devices the route is made of, in the order the user picked them: the
  // first is the one the system plays directly, the rest are mirrored. A staged
  // choice outranks a live route, because it is the route being decided now.
  const routeIds = selectedDeviceIds.length > 0 ? selectedDeviceIds : activeIds;
  const routeSet = new Set(routeIds);

  // `sort` is stable, so devices the route does not name keep the order the
  // backend reported them in: hardware that has not moved does not move.
  const rank = new Map<string, number>();
  routeIds.forEach((id, index) => rank.set(id, index));
  const ordered = [...devices].sort(
    (a, b) =>
      (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );

  const expert = advancedMode;
  const deviceW = deviceWidth(expert);

  // Where the nodes are. Everything below is derived from these, including the
  // wires, so a node and the wire that meets it cannot disagree.
  const stackH =
    ordered.length === 0 ? 0 : ordered.length * NODE_H + (ordered.length - 1) * NODE_GAP;
  const sourceTop = Math.max(0, Math.round((stackH - NODE_H) / 2));
  const sourceX = BOARD_PAD;
  const sourceY = BOARD_PAD + HEAD_H + sourceTop;
  const deviceX = BOARD_PAD + SOURCE_W + COLUMN_GAP;
  const deviceY = BOARD_PAD + HEAD_H;

  const wires: Wire[] =
    primarySession === undefined
      ? []
      : ordered.flatMap((device, index) =>
          routeSet.has(device.id)
            ? [
                {
                  key: device.id,
                  d: wirePath(
                    sourceX + SOURCE_W,
                    sourceY + NODE_H / 2,
                    deviceX,
                    deviceY + index * (NODE_H + NODE_GAP) + NODE_H / 2,
                  ),
                  tone: TONE[roleOf(device.id, selectedDeviceIds, activeIds)],
                },
              ]
            : [],
        );

  // The way back to the system default. Whichever scope the selection implies:
  // the selected programs, or — with nothing selected — every routed program,
  // because "back to default" is the only way out of a route the user is not
  // currently looking at.
  const selectedRouted = selectedPids.filter((pid) => routedPids[pid] !== undefined);
  const returnScope: (() => void) | null =
    selectedRouted.length > 0
      ? () => {
          for (const pid of selectedRouted) void stopRoute(pid);
        }
      : selectedPids.length === 0 && routedCount > 0
        ? () => void stopAllRoutes()
        : null;

  // How many programs are being routed together is worth saying only when there
  // is more than one of them; "1 selected" repeats the highlighted row beside it.
  const hint =
    selectedPids.length > 1 ? t('deviceTable.selectedHint', { n: selectedPids.length }) : null;

  const heading = 'font-mono text-[10px] uppercase tracking-wide text-text-muted';

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      {/* Whose output this is, what the selection means for it, and the way
          back. Chrome, on the same plane as the sidebar and the tabs, so the
          frame of the sheet is one continuous surface and the board is the
          recessed part. No rule under it: the grid below already starts, and
          that edge is louder than a hairline. */}
      <div className="flex h-10 flex-none items-center justify-between gap-3 bg-surface-sunken pr-3 pl-6">
        <div className="flex min-w-0 items-baseline gap-2">
          {primarySession === undefined ? (
            <span className="truncate text-[12px] text-text-muted">{t('router.guide')}</span>
          ) : (
            <>
              <span className="min-w-0 truncate text-[13px] font-medium text-text-primary">
                {primarySession.exe_name}
              </span>
              <span className="flex-none font-mono text-[10px] tabular-nums text-text-muted">
                PID {primarySession.pid}
              </span>
            </>
          )}
        </div>
        <div className="flex flex-none items-center gap-2">
          {hint !== null && <span className="text-[11px] text-text-muted">{hint}</span>}
          {returnScope !== null && (
            <ConfirmButton
              label={t('statusBar.backToDefault')}
              confirmLabel={t('statusBar.backToDefaultConfirm')}
              onConfirm={returnScope}
            />
          )}
        </div>
      </div>

      <div className="board-grid relative min-h-0 flex-1 overflow-auto bg-bg-primary">
        <div
          className="relative w-fit"
          style={{ padding: BOARD_PAD, minWidth: '100%', minHeight: '100%' }}
        >
          <EdgeLayer wires={wires} />

          <div className="flex items-start" style={{ gap: COLUMN_GAP }}>
            {/* The program. Its heading names the column the way the device
                column's does, so the two sides of the board are introduced the
                same way — and so the wires are obviously leaving somewhere. */}
            <div className="flex-none" style={{ width: SOURCE_W }}>
              <div className={`flex items-center ${heading}`} style={{ height: HEAD_H }}>
                <span className="pl-3">{t('canvas.source')}</span>
              </div>
              {primarySession !== undefined && (
                <div style={{ marginTop: sourceTop }}>
                  <SourceNode exeName={primarySession.exe_name} pid={primarySession.pid} />
                </div>
              )}
            </div>

            {/* The devices. Their headings are the table's, kept because they
                still have a job: two bare numbers a few pixels apart are a
                puzzle until something says which is which. */}
            <div className="flex-none" style={{ width: deviceW }}>
              <div className={`flex items-center ${heading}`} style={{ height: HEAD_H }}>
                <span style={{ width: NAME_W }} className="pl-3">
                  {t('deviceTable.device')}
                </span>
                <span style={{ width: ROLE_W }}>{t('deviceTable.role')}</span>
                {expert && (
                  <>
                    <span style={{ width: DELAY_W }} className="flex justify-end">
                      {t('deviceTable.delay')}
                    </span>
                    <span style={{ width: VOLUME_W }} className="flex justify-end pr-3">
                      {t('deviceTable.volume')}
                    </span>
                  </>
                )}
              </div>

              {devices.length === 0 ? (
                <p className="py-8 text-[11px] text-text-muted">{t('settings.noDevices')}</p>
              ) : (
                <motion.div layout className="flex flex-col" style={{ gap: NODE_GAP }}>
                  {ordered.map((device) => {
                    const role = roleOf(device.id, selectedDeviceIds, activeIds);
                    const engineRole = engineRoles.get(device.id) ?? 'inactive';
                    // A reading, not a setting: it only ever exists for a device
                    // a running engine is filling, and it belongs in the
                    // tooltip rather than beside the setting, where two numbers
                    // a few pixels apart read as one broken one.
                    const latency =
                      engineRole === 'mirror' ? deviceLatencyMs[device.id] : undefined;

                    return (
                      <DeviceNode
                        key={device.id}
                        deviceId={device.id}
                        name={device.name}
                        role={role}
                        engineRole={engineRole}
                        latencyMs={latency}
                        isDefaultDevice={device.id === defaultDeviceId}
                        advanced={expert}
                        delayRangeMs={delayRangeMs}
                        pressed={selectedDeviceIds.includes(device.id)}
                        onToggle={() => toggleDeviceSelection(device.id)}
                      />
                    );
                  })}
                </motion.div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
