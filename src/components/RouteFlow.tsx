import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { FADE } from '@/lib/motion';
import { useRouterStore } from '@/stores/routerStore';

/**
 * Width of the connector column between the tree spine and a device node.
 * Fixed so the nodes line up no matter how long a device name is.
 */
const SPINE_INSET = 14;
const SPINE_STUB = 14;

/**
 * The elbow of one connector: a 1 px vertical run down the spine plus the
 * horizontal stub into the node it feeds.
 *
 * The first row starts its vertical line at the middle (it comes from the
 * source node above) and the last one stops there (nothing follows it), which
 * is what makes a list of two devices read as one branch instead of as two
 * unrelated lines.
 */
function Connector({ first, last, live }: { first: boolean; last: boolean; live: boolean }) {
  const tone = live ? 'bg-accent/50' : 'bg-line';
  return (
    <span aria-hidden="true" className="relative w-4 flex-none self-stretch">
      <span
        className={`absolute ${tone}`}
        style={{
          left: SPINE_INSET,
          width: 1,
          top: first ? '50%' : 0,
          bottom: last ? '50%' : 0,
        }}
      />
      <span
        className={`absolute ${tone}`}
        style={{ left: SPINE_INSET, width: SPINE_STUB, height: 1, top: '50%' }}
      />
    </span>
  );
}

/**
 * Where the sound goes, drawn as a tree rather than described in a sentence.
 *
 * One source node (the program that would be routed) with the devices under it,
 * so the arrangement itself says "this program, those devices" — which is the
 * question the route confirm asks, and the one thing about this app a newcomer
 * has to learn. The tree replaced a radial stage whose nodes sat on an orbit:
 * the orbit was prettier, but its geometry had to be read, and a list of one
 * source and a few targets is a list.
 *
 * Live routes draw their branch in accent; a staged (unapplied) target draws it
 * in the muted accent, so "already playing there" and "about to play there" are
 * told apart at a glance.
 */
export function RouteFlow() {
  const { t } = useTranslation();
  const sessions = useRouterStore((s) => s.sessions);
  const devices = useRouterStore((s) => s.devices);
  const selectedPids = useRouterStore((s) => s.selectedPids);
  const selectedDeviceIds = useRouterStore((s) => s.selectedDeviceIds);
  const routedPids = useRouterStore((s) => s.routedPids);
  const defaultDeviceId = useRouterStore((s) => s.defaultDeviceId);

  const primaryPid = selectedPids[0];
  const primarySession =
    primaryPid === undefined ? undefined : sessions.find((s) => s.pid === primaryPid);
  const activeIds =
    selectedPids.length === 0
      ? []
      : [...new Set(selectedPids.flatMap((pid) => routedPids[pid] ?? []))];

  // The devices this branch lists: what is staged, or — when nothing is staged
  // — what the selected program is already playing on. A program that is
  // neither staged nor routed shows the system default it follows, which is
  // where its sound is going right now.
  const ids =
    selectedDeviceIds.length > 0
      ? selectedDeviceIds
      : selectedPids.length > 0 && activeIds.length > 0
        ? activeIds
        : defaultDeviceId !== null && selectedPids.length > 0
          ? [defaultDeviceId]
          : [];

  const targets = ids
    .map((id) => devices.find((d) => d.id === id))
    .filter((d): d is { id: string; name: string } => d !== undefined);

  return (
    <section className="flex flex-none flex-col gap-2 px-5 pb-4 pt-4">
      <h3 className="text-[10px] font-medium uppercase tracking-wide text-text-muted">
        {t('router.currentRoute')}
      </h3>

      {/* Source */}
      <div className="flex items-center gap-2.5">
        <span
          className={`flex h-7 w-7 flex-none items-center justify-center rounded border ${
            primarySession === undefined
              ? 'border-line bg-surface-sunken text-text-muted'
              : 'border-accent/40 bg-accent-muted text-accent'
          }`}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <rect x="3" y="4" width="18" height="14" rx="2" />
            <path d="M8 20h8" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          {primarySession === undefined ? (
            <p className="truncate text-[12px] text-text-muted">{t('router.noProcess')}</p>
          ) : (
            <>
              <p className="flex items-center gap-2 truncate text-[12px] font-medium text-text-primary">
                <span className="truncate">{primarySession.exe_name}</span>
                <span className="flex-none font-mono text-[10px] font-normal tabular-nums text-text-muted">
                  PID {primarySession.pid}
                </span>
              </p>
              <p className="truncate text-[10px] text-text-muted">
                {selectedPids.length > 1
                  ? t('router.processCount', { n: selectedPids.length })
                  : t('router.playing')}
              </p>
            </>
          )}
        </div>
      </div>

      {/* Targets */}
      {targets.length === 0 ? (
        <p className="pl-4 text-[11px] leading-relaxed text-text-muted">{t('router.guide')}</p>
      ) : (
        <div className="flex flex-col">
          {targets.map((device, index) => {
            const isLive = activeIds.includes(device.id);
            const isPrimaryOfLive = isLive && activeIds.indexOf(device.id) === 0;
            const isStaged = !isLive && selectedDeviceIds.includes(device.id);
            return (
              <motion.div
                key={device.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={FADE}
                className="flex items-stretch gap-2.5"
              >
                <Connector
                  first={index === 0}
                  last={index === targets.length - 1}
                  live={isLive || isStaged}
                />
                <div className="border-b border-line/60 py-1.5 pr-1 last:border-b-0">
                  <p
                    className={`flex items-center gap-2 text-[12px] ${
                      isLive || isStaged ? 'text-text-primary' : 'text-text-secondary'
                    }`}
                  >
                    <span className="truncate">{device.name}</span>
                    {device.id === defaultDeviceId && (
                      <span
                        title={t('router.defaultDevice')}
                        className="flex-none rounded border border-line px-1 text-[9px] text-text-muted"
                      >
                        {t('router.defaultLabel')}
                      </span>
                    )}
                  </p>
                  <p className="font-mono text-[10px] tabular-nums text-text-muted">
                    {isPrimaryOfLive
                      ? t('router.rolePrimary')
                      : isLive
                        ? t('router.roleMirror')
                        : isStaged
                          ? t('router.pending')
                          : '—'}
                  </p>
                </div>
              </motion.div>
            );
          })}
        </div>
      )}
    </section>
  );
}
