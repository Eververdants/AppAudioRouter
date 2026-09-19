import { motion, AnimatePresence, type Variants } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useRouterStore } from '@/stores/routerStore';

const container: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.05 },
  },
};

const item: Variants = {
  hidden: { opacity: 0, x: -8 },
  show: { opacity: 1, x: 0, transition: { type: 'spring', stiffness: 400, damping: 30 } },
};

/**
 * Shared layout id of the selection highlight.
 *
 * One id means one element: framer-motion slides that single pill from the row
 * it was on to the row it is on now, which is what makes a click feel like the
 * selection travelling down the list. Give each row its own id, as this list
 * used to, and there is nothing to slide — the old pill just disappears and a
 * new one appears.
 */
const SELECTION_PILL_LAYOUT_ID = 'process-selection-pill';

const SELECTION_PILL_CLASS =
  'pointer-events-none absolute inset-0 rounded-lg border border-accent/60 bg-accent-muted';

/**
 * The highlight behind a chosen row.
 *
 * A layout id can only exist once at a time, so the sliding pill belongs to one
 * row — the first selected process — and the rest of a Ctrl multi-selection get
 * a static twin. Without that split the second selected row would be left bare,
 * which is the reason the per-row ids were there in the first place.
 *
 * It is a sibling of the row button rather than a child: the button scales on
 * tap, and a transform on an ancestor skews the box framer-motion measures, so
 * the pill would miss its target whenever a tap and a slide happened together.
 */
function SelectionPill({ selected, sliding }: { selected: boolean; sliding: boolean }) {
  if (!selected) return null;
  return sliding ? (
    <motion.span
      key="sliding"
      layoutId={SELECTION_PILL_LAYOUT_ID}
      transition={{ type: 'spring', stiffness: 450, damping: 34 }}
      className={SELECTION_PILL_CLASS}
    />
  ) : (
    <motion.span
      key="static"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      className={SELECTION_PILL_CLASS}
    />
  );
}

export function ProcessList() {
  const { t } = useTranslation();
  const devices = useRouterStore((s) => s.devices);
  const sessions = useRouterStore((s) => s.sessions);
  const selectedPids = useRouterStore((s) => s.selectedPids);
  const routedPids = useRouterStore((s) => s.routedPids);
  const defaultDeviceId = useRouterStore((s) => s.defaultDeviceId);
  const selectProcess = useRouterStore((s) => s.selectProcess);
  const toggleProcessSelection = useRouterStore((s) => s.toggleProcessSelection);
  const stopRoute = useRouterStore((s) => s.stopRoute);
  const stopAllRoutes = useRouterStore((s) => s.stopAllRoutes);
  const refreshSessions = useRouterStore((s) => s.refreshSessions);

  const routedCount = Object.keys(routedPids).length;
  // The first selected process owns the sliding pill, so a plain click on
  // another row carries the highlight across instead of blinking.
  const anchorPid: number | null = selectedPids[0] ?? null;

  /** Playback device a process is associated with: its route's primary device,
   * or the system default it currently plays through. */
  const associatedName = (pid: number): string | null => {
    const id = routedPids[pid]?.[0] ?? defaultDeviceId;
    if (id === null) return null;
    return devices.find((d) => d.id === id)?.name ?? null;
  };

  return (
    <div className="flex h-full flex-col rounded-2xl border border-glass bg-glass p-4 shadow-glass backdrop-blur-xl">
      <div className="mb-3 flex items-center justify-between gap-1">
        <h2 className="truncate text-sm font-semibold text-text-primary">
          {t('processList.title')}
        </h2>
        <div className="flex flex-none items-center">
          <AnimatePresence initial={false}>
            {routedCount > 0 && (
              <motion.button
                initial={{ opacity: 0, scale: 0.7 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.7 }}
                whileHover={{ scale: 1.08 }}
                whileTap={{ scale: 0.9 }}
                transition={{ type: 'spring', stiffness: 480, damping: 24 }}
                onClick={() => void stopAllRoutes()}
                title={t('processList.stopAll')}
                aria-label={t('processList.stopAll')}
                className="mr-0.5 flex h-6 w-6 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-error/10 hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error/50"
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="9" />
                  <rect x="9" y="9" width="6" height="6" rx="1" />
                </svg>
              </motion.button>
            )}
          </AnimatePresence>
          <motion.button
            onClick={refreshSessions}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.92 }}
            transition={{ type: 'spring', stiffness: 500, damping: 25 }}
            className="rounded-md px-2 py-1 text-xs text-text-muted transition-colors hover:bg-bg-tertiary hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {t('processList.refresh')}
          </motion.button>
        </div>
      </div>

      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="flex-1 space-y-1.5 overflow-y-auto"
      >
        {sessions.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="text-text-muted/60"
            >
              <path d="M11 5 6 9H2v6h4l5 4V5z" />
              <line x1="22" y1="9" x2="16" y2="15" />
              <line x1="16" y1="9" x2="22" y2="15" />
            </svg>
            <p className="text-xs leading-relaxed text-text-muted">
              {t('processList.empty')}
              <br />
              <span className="text-[10px]">{t('processList.emptyHint')}</span>
            </p>
          </div>
        ) : (
          sessions.map((session) => {
            const routedCountForPid = routedPids[session.pid]?.length ?? 0;
            const isSelected = selectedPids.includes(session.pid);
            const deviceName = associatedName(session.pid);
            return (
              <motion.div key={session.pid} variants={item}>
                <div className="relative">
                  <SelectionPill
                    selected={isSelected}
                    sliding={session.pid === anchorPid}
                  />
                  <motion.button
                    onClick={(e) => {
                      // Ctrl+click adds to the selection so several processes
                      // can be routed in one go.
                      if (e.ctrlKey || e.metaKey) {
                        toggleProcessSelection(session.pid);
                      } else {
                        selectProcess(session.pid);
                      }
                    }}
                    whileTap={{ scale: 0.97 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 28 }}
                    title={t('processList.multiSelectHint')}
                    className="relative w-full rounded-lg px-3 py-2 pr-9 text-left text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60"
                  >
                    <span
                      className={`relative flex items-center gap-1.5 font-medium ${
                        isSelected ? 'text-accent' : 'text-text-secondary'
                      }`}
                    >
                      <span className="truncate">{session.exe_name}</span>
                      {routedCountForPid > 0 && (
                        <span
                          title={t('processList.routedBadge', { n: routedCountForPid })}
                          className="flex h-4 min-w-4 flex-none items-center justify-center rounded-full bg-accent px-1 text-[9px] font-semibold leading-none text-white"
                        >
                          {routedCountForPid}
                        </span>
                      )}
                      {selectedPids.length > 1 && isSelected && (
                        <span className="ml-auto flex-none text-[9px] font-semibold text-accent/70">
                          #{selectedPids.indexOf(session.pid) + 1}
                        </span>
                      )}
                    </span>
                    {/* PID and the device the process plays through share one
                        muted line: a row of its own made the list feel dense
                        for a detail that is only reference information. */}
                    <span className="relative flex items-center gap-1 text-[10px] text-text-muted">
                      <span className="flex-none">PID {session.pid}</span>
                      {deviceName !== null && (
                        <>
                          <span className="flex-none opacity-50">·</span>
                          <span
                            className="truncate"
                            title={t('processList.associatedDevice', { device: deviceName })}
                          >
                            {deviceName}
                          </span>
                        </>
                      )}
                    </span>
                  </motion.button>
                  <AnimatePresence>
                    {routedCountForPid > 0 && (
                      <motion.button
                        initial={{ opacity: 0, scale: 0.6 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.6 }}
                        whileHover={{ scale: 1.15 }}
                        whileTap={{ scale: 0.9 }}
                        onClick={() => void stopRoute(session.pid)}
                        title={t('processList.stopRoute')}
                        aria-label={t('processList.stopRoute')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-text-muted transition-colors hover:bg-error/10 hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-error/50"
                      >
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 10 10"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                        >
                          <line x1="1" y1="1" x2="9" y2="9" />
                          <line x1="9" y1="1" x2="1" y2="9" />
                        </svg>
                      </motion.button>
                    )}
                  </AnimatePresence>
                </div>
              </motion.div>
            );
          })
        )}
      </motion.div>
    </div>
  );
}
