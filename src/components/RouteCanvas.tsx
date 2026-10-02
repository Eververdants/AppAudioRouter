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
  type NodeRole,
} from '@/lib/canvas';
import { activeDeviceIds, engineRolesFor } from '@/lib/engineRole';
import { useRouterStore } from '@/stores/routerStore';

/**
 * The routing screen: a node graph of every program whose sound goes somewhere,
 * and the devices it goes to.
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
 * The board shows every routed program at once, not just the one being routed:
 * the question this screen answers is "where is sound going", and an answer
 * that hides all routes but the newest is a list again. So a source column on
 * the left — one node per routed program, plus the selection when it is not
 * routed yet — a device column on the right, and one Bézier per program-device
 * pair. Each wire wears the colour of what *its own* route does with the
 * device it reaches: with several programs on the board, one device can be a
 * primary for one of them and a mirror for another, and the wires are the only
 * place that difference can live. The device's own port and role word follow
 * the selection when there is one, and its first route otherwise.
 *
 * What is deliberately *not* here: no free-dragging, no pan, no zoom. Node
 * positions come from the route order, which means the wires are arithmetic
 * rather than measurement (see `lib/canvas.ts`), which means nothing has to be
 * tracked across a layout pass — and a canvas of six nodes has nothing to
 * explore anyway. Pan and zoom are how you find something you cannot see; the
 * whole board fits, so there is nothing to find. The fan-out *is* the animation
 * budget: when a device joins the route its node travels on a spring and its
 * wire arrives with it.
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
  const selectProcess = useRouterStore((s) => s.selectProcess);
  const toggleProcessSelection = useRouterStore((s) => s.toggleProcessSelection);
  const stopRoute = useRouterStore((s) => s.stopRoute);
  const stopAllRoutes = useRouterStore((s) => s.stopAllRoutes);

  const engineRoles = engineRolesFor(routedPids);
  const routedCount = Object.keys(routedPids).length;

  const primaryPid = selectedPids[0];
  const primarySession =
    primaryPid === undefined ? undefined : sessions.find((s) => s.pid === primaryPid);

  // The programs on the board: every routed one — `routedPids`' keys iterate in
  // ascending PID order, so the column is stable across refreshes — and then
  // the selection when it is not routed yet, because that is the program a
  // route is currently being decided for. Selected programs that are already
  // routed stay where they were and are drawn louder instead.
  const stagedSourcePids = selectedPids.filter((pid) => routedPids[pid] === undefined);
  const sourcePids = [...Object.keys(routedPids).map(Number), ...stagedSourcePids];

  // The devices the routes are made of. Every routed program's targets, in
  // route order, deduplicated by first appearance; then whatever the selection
  // has staged but no route holds yet, because that is the question on the
  // board. The remaining devices keep the order the backend reported them in —
  // the sort is stable, so hardware that has not moved does not move.
  const rank = new Map<string, number>();
  for (const pid of sourcePids) {
    for (const id of routedPids[pid] ?? []) if (!rank.has(id)) rank.set(id, rank.size);
  }
  for (const id of selectedDeviceIds) if (!rank.has(id)) rank.set(id, rank.size);
  const ordered = [...devices].sort(
    (a, b) =>
      (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );

  const expert = advancedMode;
  const deviceW = deviceWidth(expert);

  // Where the nodes are. Everything below is derived from these, including the
  // wires, so a node and the wire that meets it cannot disagree. Both columns
  // are centred against the taller of the two stacks, so a single source among
  // five devices sits in the middle of its column rather than at its top.
  const stackH = (count: number) =>
    count === 0 ? 0 : count * NODE_H + (count - 1) * NODE_GAP;
  const contentH = Math.max(stackH(sourcePids.length), stackH(ordered.length));
  const sourceTop = Math.round((contentH - stackH(sourcePids.length)) / 2);
  const deviceTop = Math.round((contentH - stackH(ordered.length)) / 2);
  const sourceX = BOARD_PAD;
  const sourceY = BOARD_PAD + HEAD_H;
  const deviceX = BOARD_PAD + SOURCE_W + COLUMN_GAP;
  const deviceY = BOARD_PAD + HEAD_H;
  const portY = (top: number, index: number) =>
    top + index * (NODE_H + NODE_GAP) + NODE_H / 2;

  // The subject's staged choice replaces the display of its own route while a
  // route is being decided — the board shows the question, not the state it is
  // about to replace. Every other source shows the route it has.
  const wires: Wire[] = [];
  for (const pid of sourcePids) {
    const isSubject = selectedPids.includes(pid);
    const active = routedPids[pid];
    const ids = isSubject && selectedDeviceIds.length > 0 ? selectedDeviceIds : (active ?? []);
    if (ids.length === 0) continue;
    const index = sourcePids.indexOf(pid);
    const fromY = sourceY + portY(sourceTop, index);
    for (let target = 0; target < ids.length; target += 1) {
      const deviceId = ids[target];
      if (deviceId === undefined) continue;
      const deviceIndex = ordered.findIndex((device) => device.id === deviceId);
      if (deviceIndex < 0) continue;
      wires.push({
        key: `${pid}:${deviceId}`,
        d: wirePath(
          sourceX + SOURCE_W,
          fromY,
          deviceX,
          deviceY + portY(deviceTop, deviceIndex),
        ),
        // A wire is coloured by what its own route does with the device it
        // reaches; only the subject's staged choice can wear the amber of a
        // question not yet answered, which is what passing it an empty staged
        // list arranges for every other source.
        tone: TONE[roleOf(deviceId, isSubject ? selectedDeviceIds : [], active ?? [])],
      });
    }
  }

  // A device's port and role word follow the subject when there is one — that
  // is the routing context the user is working in — and the first route that
  // involves the device otherwise, so a board read with nothing selected still
  // says what each routed device is for instead of calling them all idle.
  const subjectActive = activeDeviceIds(selectedPids, routedPids);
  const deviceRole = (deviceId: string): NodeRole => {
    const contextual = roleOf(deviceId, selectedDeviceIds, subjectActive);
    if (contextual !== 'idle') return contextual;
    for (const pid of sourcePids) {
      const route = routedPids[pid];
      const index = route?.indexOf(deviceId) ?? -1;
      if (index === 0) return 'primary';
      if (index > 0) return 'mirror';
    }
    return 'idle';
  };

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
            {/* The programs. Its heading names the column the way the device
                column's does, so the two sides of the board are introduced the
                same way — and so the wires are obviously leaving somewhere. */}
            <div className="flex-none" style={{ width: SOURCE_W }}>
              <div className={`flex items-center ${heading}`} style={{ height: HEAD_H }}>
                <span className="pl-3">{t('canvas.source')}</span>
              </div>
              {sourcePids.length > 0 && (
                <div style={{ marginTop: sourceTop }}>
                  <motion.div layout className="flex flex-col" style={{ gap: NODE_GAP }}>
                    {sourcePids.map((pid) => {
                      const exeName =
                        sessions.find((session) => session.pid === pid)?.exe_name ??
                        `PID ${pid}`;
                      return (
                        <SourceNode
                          key={pid}
                          exeName={exeName}
                          pid={pid}
                          selected={selectedPids.includes(pid)}
                          onSelect={(event) => {
                            // The same two gestures the app list offers: plain
                            // click makes this the subject, Ctrl+click adds it
                            // to a batch. A board and a list that answer the
                            // same click differently would be two UIs.
                            if (event.ctrlKey || event.metaKey) {
                              toggleProcessSelection(pid);
                            } else {
                              selectProcess(pid);
                            }
                          }}
                        />
                      );
                    })}
                  </motion.div>
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
                <div style={{ marginTop: deviceTop }}>
                  <motion.div layout className="flex flex-col" style={{ gap: NODE_GAP }}>
                    {ordered.map((device) => {
                      const role = deviceRole(device.id);
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
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
