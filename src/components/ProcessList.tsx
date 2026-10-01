import { useMemo, useState } from 'react';
import { motion, AnimatePresence, type Variants } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { ConfirmButton } from '@/components/ui/ConfirmButton';
import { FADE, SPRING_GLIDE, SPRING_TAP } from '@/lib/motion';
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
  show: { opacity: 1, x: 0, transition: SPRING_GLIDE },
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
      transition={SPRING_GLIDE}
      className={SELECTION_PILL_CLASS}
    />
  ) : (
    <motion.span
      key="static"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={FADE}
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
  const [query, setQuery] = useState('');

  /** The rows on screen: filtered by what was typed, routed processes floated
   * to the top. A stable sort keeps the enumeration order within each group,
   * so rows do not reshuffle among themselves while audio comes and goes. */
  const visibleSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? sessions.filter((s) => s.exe_name.toLowerCase().includes(q)) : sessions;
    return [...filtered].sort(
      (a, b) => (routedPids[b.pid]?.length ?? 0) - (routedPids[a.pid]?.length ?? 0),
    );
  }, [sessions, query, routedPids]);

  /** Playback device a process is associated with: its route's primary device,
   * or the system default it currently plays through. */
  const deviceNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of devices) map.set(d.id, d.name);
    return map;
  }, [devices]);

  const associatedName = (pid: number): string | null => {
    const id = routedPids[pid]?.[0] ?? defaultDeviceId;
    if (id === null) return null;
    return deviceNameById.get(id) ?? null;
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
              <motion.span
                key="stop-all"
                initial={{ opacity: 0, scale: 0.7 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.7 }}
                transition={SPRING_TAP}
                className="flex"
              >
                {/* Stops every routed program at once, so it asks first: one
                    click on this icon otherwise takes the audio of programs the
                    user was not even looking at. */}
                <ConfirmButton
                  variant="icon"
                  label={t('processList.stopAll')}
                  confirmLabel={t('processList.stopAllConfirm')}
                  onConfirm={() => void stopAllRoutes()}
                  icon={
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
                  }
                />
              </motion.span>
            )}
          </AnimatePresence>
          <motion.button
            // Called through a lambda on purpose: `refreshSessions` takes an
            // optional "this came from a notification" flag, and the click event
            // would arrive as a truthy one if the handler were passed directly.
            onClick={() => void refreshSessions()}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.92 }}
            transition={SPRING_TAP}
            className="rounded-md px-2 py-1 text-xs text-text-muted transition-colors hover:bg-bg-tertiary hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {t('processList.refresh')}
          </motion.button>
        </div>
      </div>

      {sessions.length > 0 && (
        <div className="relative mb-2 flex-none">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted"
          >
            <circle cx="11" cy="11" r="7" />
            <line x1="20" y1="20" x2="16.5" y2="16.5" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Escape clears and returns the focus to nowhere in particular,
              // matching how search boxes behave everywhere else.
              if (e.key === 'Escape') {
                setQuery('');
                e.currentTarget.blur();
              }
            }}
            placeholder={t('processList.search')}
            aria-label={t('processList.search')}
            className="bg-bg-secondary/60 w-full rounded-lg border border-transparent py-1.5 pl-7 pr-2 text-xs text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent/50 focus:bg-bg-secondary"
          />
        </div>
      )}

      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="flex-1 space-y-1.5 overflow-y-auto"
      >
        {visibleSessions.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            {query.trim() === '' && (
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
            )}
            <p className="text-xs leading-relaxed text-text-muted">
              {query.trim() === '' ? t('processList.empty') : t('processList.noMatch')}
              {query.trim() === '' && (
                <>
                  <br />
                  <span className="text-[10px]">{t('processList.emptyHint')}</span>
                </>
              )}
            </p>
          </div>
        ) : (
          visibleSessions.map((session) => {
            const routedCountForPid = routedPids[session.pid]?.length ?? 0;
            const isSelected = selectedPids.includes(session.pid);
            const deviceName = associatedName(session.pid);
            return (
              <motion.div key={session.pid} variants={item}>
                <div className="relative">
                  <SelectionPill selected={isSelected} sliding={session.pid === anchorPid} />
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
                    transition={SPRING_TAP}
                    title={t('processList.multiSelectHint')}
                    className={`relative w-full rounded-lg px-3 py-2 pr-9 text-left text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60 ${
                      // A selected row already carries the accent pill; a hover
                      // wash on top would only muddy it.
                      isSelected ? '' : 'hover:bg-bg-tertiary/40'
                    }`}
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
                    <span className="relative flex items-center gap-1 text-[10px] tabular-nums text-text-muted">
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
                      <motion.span
                        initial={{ opacity: 0, scale: 0.6 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.6 }}
                        transition={SPRING_TAP}
                        className="absolute right-2 top-1/2 flex -translate-y-1/2"
                      >
                        {/* Stopping sends the program's sound back to the
                            system default — harmless, but baffling when it
                            happens under an accidental click, so it asks first,
                            the same way the stop-all in the header does. */}
                        <ConfirmButton
                          variant="icon"
                          label={t('processList.stopRoute')}
                          confirmLabel={t('processList.stopRouteConfirm')}
                          onConfirm={() => void stopRoute(session.pid)}
                          icon={
                            <svg
                              width="10"
                              height="10"
                              viewBox="0 0 10 10"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              aria-hidden="true"
                            >
                              <line x1="1" y1="1" x2="9" y2="9" />
                              <line x1="9" y1="1" x2="1" y2="9" />
                            </svg>
                          }
                        />
                      </motion.span>
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
