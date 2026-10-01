import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { ConfirmButton } from '@/components/ui/ConfirmButton';
import { DelayReadout } from '@/components/ui/DelayReadout';
import { VolumeReadout } from '@/components/ui/VolumeReadout';
import { activeDeviceIds, engineRolesFor } from '@/lib/engineRole';
import { SPRING_GLIDE } from '@/lib/motion';
import { useRouterStore } from '@/stores/routerStore';

/**
 * Column widths, shared by the header and the rows so the two never drift.
 *
 * The device column is a fixed 200 px that may shrink, not a share of the pane.
 * As a share it grew to 46 % of the work area and left the role word stranded
 * two hundred pixels from the name it belongs to — a hole in the middle of the
 * row, which reads as a mistake rather than as a column. 200 px is about what
 * a device name plus the system-default suffix actually needs; everything the
 * row does not use goes to the spacer, where it separates the two halves of the
 * row (what the device is called, what the route does with it) instead of
 * splitting one of them. `shrink` is what keeps the table inside the pane at
 * the window's minimum width, where 200 px would no longer fit.
 */
const COL_DEVICE = 'w-[200px] min-w-[110px] shrink';
const COL_ROLE = 'w-[84px] flex-none truncate';
const COL_DELAY = 'w-[92px] flex-none justify-end';
const COL_VOLUME = 'w-[72px] flex-none justify-end';
/** Left padding of a row, shared by the header, the headings and the rows. */
const ROW_PAD = 'pr-4 pl-6';

/**
 * What a device is currently doing for the selection.
 *
 * The first two are facts about a live route — the OS plays the primary, the
 * engine mirrors the rest. `staged` is the one that is not a fact yet: the
 * device is selected and would be routed if the user confirms. `idle` is a
 * device no route touches, which is most of them most of the time.
 */
type RowRole = 'primary' | 'mirror' | 'staged' | 'idle';

function roleOf(deviceId: string, staged: string[], activeIds: string[]): RowRole {
  const activeIndex = activeIds.indexOf(deviceId);
  if (activeIndex === 0) return 'primary';
  if (activeIndex > 0) return 'mirror';
  return staged.includes(deviceId) ? 'staged' : 'idle';
}

/**
 * The output devices, with the program they belong to on the header line.
 *
 * The rows a route is made of sort to the top in route order — the device the
 * system plays directly first, the copies under it — and a stronger rule closes
 * the block, so the leading rows *are* the route and the rest is hardware
 * nothing is using. That is why there is no diagram above the table any more: a
 * separate picture of "one program, these devices" was the same list a second
 * time, and the two disagreed about the order.
 *
 * The program itself is the one thing the table cannot say, so it is the one
 * thing the header says. Naming the list as well ("output devices") would cost
 * a second rule and a second line to explain what four column headings already
 * explain. The header wears no rule of its own for the same reason: it is the
 * table's first line, and the rule under the column headings is already the one
 * that separates the table from its labels. Four rules used to be stacked in
 * the top hundred pixels, and the eye reads that as fence, not as structure.
 *
 * A row is the unit of the routing decision, so the row is what clicking
 * selects. The delay and volume cells are their own controls (see
 * `ScrubReadout`) and sit beside — not inside — the clickable cell, which is
 * why that cell is a button and the row is not: a control inside a control
 * cannot be reached reliably, least of all by keyboard.
 *
 * Which rows are in the route is said once, by the wash they sit on, and not a
 * second time by a bar in the leading gutter. A 2 px accent bar there — the
 * mark the app list uses — put a vertical line twelve pixels from the pane's own
 * hairline, and two vertical lines that close together read as a rendering
 * fault rather than as a selection. Accent is still spent carefully: the wash,
 * and a value that has been moved off its neutral position. The role words are
 * plain text, because a table where four columns are coloured is a table where
 * colour says nothing.
 */
export function DeviceTable() {
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

  // The rows the route is made of, in the order the user picked them: the first
  // is the one the system plays directly, the rest are mirrored. A staged
  // choice outranks a live route, because it is the route being decided now.
  const routeIds = selectedDeviceIds.length > 0 ? selectedDeviceIds : activeIds;
  const routeKey = routeIds.join('\u0000');

  const ordered = useMemo(() => {
    const rank = new Map<string, number>();
    routeKey.split('\u0000').forEach((id, index) => {
      if (id !== '') rank.set(id, index);
    });
    // `sort` is stable, so devices the route does not name keep the order the
    // backend reported them in: hardware that has not moved does not move.
    return [...devices].sort(
      (a, b) =>
        (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
  }, [devices, routeKey]);

  const routeSet = new Set(routeIds);
  // `ordered` is sorted, so the route is its leading run and this is where the
  // rule that closes the group goes.
  const routeCount = ordered.filter((device) => routeSet.has(device.id)).length;

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
  // is more than one of them; "1 selected" repeats the highlighted row above it.
  const hint =
    selectedPids.length > 1 ? t('deviceTable.selectedHint', { n: selectedPids.length }) : null;

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      {/* Header: whose output this is, what the selection means for it, and the
          way back. No rule under it — it is the table's title line, and the
          heading row below already carries the rule. */}
      <div className="flex h-10 flex-none items-center justify-between gap-3 pr-3 pl-6">
        <div className="flex min-w-0 items-baseline gap-2">
          {primarySession === undefined ? (
            <span className="truncate text-[12px] text-text-muted">{t('router.guide')}</span>
          ) : (
            <>
              <h2 className="min-w-0 truncate text-[13px] font-medium text-text-primary">
                {primarySession.exe_name}
              </h2>
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

      {/* Column headings. A table with four columns and no headings is a
          guessing game the first time it is read. */}
      <div
        className={`flex h-7 flex-none items-center gap-3 border-b border-line font-mono text-[10px] tracking-wide text-text-muted uppercase ${ROW_PAD}`}
      >
        <span className={COL_DEVICE}>{t('deviceTable.device')}</span>
        <span className={COL_ROLE}>{t('deviceTable.role')}</span>
        <span aria-hidden="true" className="flex-1" />
        {advancedMode && (
          <>
            <span className={`${COL_DELAY} flex`}>{t('deviceTable.delay')}</span>
            <span className={`${COL_VOLUME} flex`}>{t('deviceTable.volume')}</span>
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {devices.length === 0 ? (
          <p className="px-6 py-8 text-center text-[11px] text-text-muted">
            {t('settings.noDevices')}
          </p>
        ) : (
          ordered.map((device, index) => {
            const role = roleOf(device.id, selectedDeviceIds, activeIds);
            const engineRole = engineRoles.get(device.id) ?? 'inactive';
            // A reading, not a setting: it only ever exists for a device a
            // running engine is filling, and it belongs in the tooltip rather
            // than beside the setting, where two numbers a few pixels apart
            // read as one broken one.
            const latency = engineRole === 'mirror' ? deviceLatencyMs[device.id] : undefined;
            const roleLabel =
              role === 'primary'
                ? t('router.rolePrimary')
                : role === 'mirror'
                  ? t('router.roleMirror')
                  : role === 'staged'
                    ? t('router.pending')
                    : '—';
            const inRoute = role !== 'idle';
            // The rule that closes the route group: the rows above it are the
            // route, everything below is hardware the route is not using.
            const closesGroup = index === routeCount - 1 && routeCount < ordered.length;

            return (
              <motion.div
                key={device.id}
                layout
                transition={SPRING_GLIDE}
                data-device-row={device.id}
                className={`group/row relative flex min-h-10 items-center gap-3 transition-colors hover:bg-surface-hover ${ROW_PAD} ${
                  inRoute ? 'bg-accent/[0.06] dark:bg-accent/[0.09]' : ''
                } ${closesGroup ? 'border-b border-line-strong' : 'border-b border-line last:border-b-0'}`}
              >
                {/* The clickable part of the row: what the device is called.
                    The role beside it is a fact about the route, not a second
                    name for the device, and the readouts further along are
                    controls in their own right. */}
                <button
                  type="button"
                  onClick={() => toggleDeviceSelection(device.id)}
                  aria-pressed={selectedDeviceIds.includes(device.id)}
                  aria-label={device.name}
                  title={device.name}
                  className={`${COL_DEVICE} flex items-center gap-2 self-stretch py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60`}
                >
                  <span
                    className={`min-w-0 truncate text-[13px] ${
                      role === 'idle' ? 'text-text-secondary' : 'text-text-primary'
                    }`}
                  >
                    {device.name}
                  </span>
                  {/* Which device Windows would use if nothing were routed is a
                      fact about the device, so it is written next to its name in
                      the same muted type the app list uses for its second line —
                      not as a bordered badge, which would be the only box in a
                      window built out of hairlines. */}
                  {device.id === defaultDeviceId && (
                    <>
                      <span aria-hidden="true" className="flex-none text-text-muted/50">
                        ·
                      </span>
                      <span
                        className="flex-none text-[11px] text-text-muted"
                        title={t('router.defaultDevice')}
                      >
                        {t('router.defaultLabel')}
                      </span>
                    </>
                  )}
                </button>

                <span
                  className={`${COL_ROLE} text-[11px] ${
                    role === 'idle' ? 'text-text-muted' : 'text-text-secondary'
                  }`}
                >
                  {roleLabel}
                </span>

                <span aria-hidden="true" className="flex-1" />

                {advancedMode && (
                  <>
                    <span className={`${COL_DELAY} flex items-center`}>
                      <DelayReadout
                        deviceId={device.id}
                        name={device.name}
                        rangeMs={delayRangeMs}
                        engineRole={engineRole}
                        latencyMs={latency}
                      />
                    </span>
                    <span className={`${COL_VOLUME} flex items-center`}>
                      <VolumeReadout
                        deviceId={device.id}
                        name={device.name}
                        engineRole={engineRole}
                      />
                    </span>
                  </>
                )}
              </motion.div>
            );
          })
        )}
      </div>
    </section>
  );
}
