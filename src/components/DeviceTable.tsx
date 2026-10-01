import { useTranslation } from 'react-i18next';
import { ConfirmButton } from '@/components/ui/ConfirmButton';
import { DelayReadout } from '@/components/ui/DelayReadout';
import { VolumeReadout } from '@/components/ui/VolumeReadout';
import { activeDeviceIds, engineRolesFor } from '@/lib/engineRole';
import { useRouterStore } from '@/stores/routerStore';

/** Column widths, shared by the header and the rows so the two never drift. */
const COL_ROLE = 'w-[76px] flex-none';
const COL_DELAY = 'w-[92px] flex-none justify-end';
const COL_VOLUME = 'w-[64px] flex-none justify-end';

/**
 * What a device is currently doing for the selection.
 *
 * The first three are facts about a live route — the OS plays the primary, the
 * engine mirrors the rest. `staged` is the one that is not a fact yet: the
 * device is selected and would be routed if the user confirms. `idle` is a
 * device no route touches, which is most of them most of the time and is
 * therefore left blank rather than labelled.
 */
type RowRole = 'primary' | 'mirror' | 'staged' | 'idle';

function roleOf(deviceId: string, staged: string[], activeIds: string[]): RowRole {
  const activeIndex = activeIds.indexOf(deviceId);
  if (activeIndex === 0) return 'primary';
  if (activeIndex > 0) return 'mirror';
  return staged.includes(deviceId) ? 'staged' : 'idle';
}

/**
 * What a mirrored device is really playing at, in milliseconds.
 *
 * A reading, not a control: it keeps the small unit and the tabular figures of
 * the editable cells beside it, and stays muted — in this table accent means
 * "you can act on this", and a number nobody can grab must not wear it.
 */
function LatencyNote({ latencyMs }: { latencyMs: number }) {
  const { t } = useTranslation();
  return (
    <span title={t('deviceLatency.hint')} className="flex-none font-mono text-[10px] text-text-muted">
      {latencyMs}ms
    </span>
  );
}

/**
 * The devices, as a table: one row each, one column per fact.
 *
 * A row is the unit of the routing decision, so the row is what clicking
 * selects. The delay and volume cells are their own controls (see
 * `ScrubReadout`) and sit beside — not inside — the clickable name cell, which
 * is why the name cell is a button and the row is not: a control inside a
 * control cannot be reached reliably, least of all by keyboard.
 *
 * The expert columns are gated by the advanced switch. With it off the table
 * is two columns — which device, and what it is doing — because a number a
 * novice did not ask for is a number they can drag by accident.
 */
export function DeviceTable() {
  const { t } = useTranslation();
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

  const hint =
    selectedPids.length > 0
      ? t('deviceTable.selectedHint', { n: selectedPids.length })
      : t('deviceTable.selectHint');

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      {/* Section header: the standing label, what the selection means for it,
          and the way back. */}
      <div className="flex h-9 flex-none items-center justify-between gap-3 border-b border-line pl-5 pr-4">
        <h3 className="flex-none text-[11px] font-semibold text-text-secondary">
          {t('deviceTable.title')}
        </h3>
        <div className="flex min-w-0 items-center gap-3">
          <span className="truncate text-[11px] text-text-muted">{hint}</span>
          {returnScope !== null && (
            <ConfirmButton
              label={t('statusBar.backToDefault')}
              confirmLabel={t('statusBar.backToDefaultConfirm')}
              onConfirm={returnScope}
            />
          )}
        </div>
      </div>

      {/* Column headings. A table with five columns and no headings is a
          guessing game the first time it is read. */}
      <div className="flex h-8 flex-none items-center gap-3 border-b border-line pl-5 pr-4 font-mono text-[10px] uppercase tracking-wide text-text-muted">
        <span className="min-w-0 flex-1">{t('deviceTable.device')}</span>
        <span className={COL_ROLE}>{t('deviceTable.role')}</span>
        {advancedMode && (
          <>
            <span className={`${COL_DELAY} flex`}>{t('deviceTable.delay')}</span>
            <span className={`${COL_VOLUME} flex`}>{t('deviceTable.volume')}</span>
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {devices.length === 0 ? (
          <p className="px-5 py-8 text-center text-[11px] text-text-muted">
            {t('settings.noDevices')}
          </p>
        ) : (
          devices.map((device) => {
            const role = roleOf(device.id, selectedDeviceIds, activeIds);
            const engineRole = engineRoles.get(device.id) ?? 'inactive';
            const latency = engineRole === 'mirror' ? deviceLatencyMs[device.id] : undefined;
            return (
              <div
                key={device.id}
                className="flex min-h-11 items-center gap-3 border-b border-line pl-5 pr-4 last:border-b-0 transition-colors hover:bg-surface-hover"
              >
                {/* The clickable half of the row. Everything else in the row is
                    either a readout or a fact about this click. */}
                <button
                  type="button"
                  onClick={() => toggleDeviceSelection(device.id)}
                  aria-pressed={selectedDeviceIds.includes(device.id)}
                  title={device.name}
                  className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
                >
                  <span
                    className={`truncate text-[13px] ${
                      role === 'idle' ? 'text-text-secondary' : 'text-text-primary'
                    }`}
                  >
                    {device.name}
                  </span>
                  {device.id === defaultDeviceId && (
                    <span
                      title={t('router.defaultDevice')}
                      className="flex-none rounded border border-line px-1 font-mono text-[9px] text-text-muted"
                    >
                      {t('router.defaultLabel')}
                    </span>
                  )}
                </button>

                <span
                  className={`${COL_ROLE} truncate text-[11px] ${
                    role === 'primary' || role === 'staged'
                      ? 'font-medium text-accent'
                      : 'text-text-muted'
                  }`}
                >
                  {role === 'primary'
                    ? t('router.rolePrimary')
                    : role === 'mirror'
                      ? t('router.roleMirror')
                      : role === 'staged'
                        ? t('router.pending')
                        : '—'}
                </span>

                {advancedMode && (
                  <>
                    <span className={`${COL_DELAY} flex items-center gap-1.5`}>
                      {latency !== undefined && <LatencyNote latencyMs={latency} />}
                      <DelayReadout
                        deviceId={device.id}
                        name={device.name}
                        rangeMs={delayRangeMs}
                        engineRole={engineRole}
                      />
                    </span>
                    <span className={`${COL_VOLUME} flex`}>
                      <VolumeReadout
                        deviceId={device.id}
                        name={device.name}
                        engineRole={engineRole}
                      />
                    </span>
                  </>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
