import { useMemo, useState } from 'react';
import { motion, AnimatePresence, type Variants } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { ConfirmButton } from '@/components/ui/ConfirmButton';
import { FADE, SPRING_TAP } from '@/lib/motion';
import { useRouterStore } from '@/stores/routerStore';

const container: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.04 },
  },
};

const item: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: FADE },
};

/**
 * The highlight behind a chosen row.
 *
 * A 2 px accent bar on the leading edge plus the faintest accent wash — the
 * shape a selection takes in an editor's file list. It replaced a sliding
 * outline that travelled from row to row: that animation was pleasant, but it
 * drew a box around a row in a list where nothing else is boxed, and a list
 * whose rows are separated by hairlines does not need its selection outlined as
 * well as marked.
 *
 * A multi-selection marks every row the same way: the rows are the same kind of
 * thing, and the first one is distinguished by the order of routing (the `#n`
 * on the right), not by a different highlight.
 */
function SelectionMark({ selected }: { selected: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute inset-y-0 left-0 w-0.5 transition-colors ${
        selected ? 'bg-accent' : 'bg-transparent'
      }`}
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
    // No frame: this panel is a plane of the window, separated from the work
    // area by the hairline the layout puts between them. A panel that draws its
    // own border inside a bordered window is one border too many.
    <div className="flex h-full flex-col overflow-hidden bg-surface-sunken">
      <div className="flex h-11 flex-none items-center justify-between gap-1 border-b border-line pl-4 pr-2">
        <h2 className="truncate text-[11px] font-semibold text-text-secondary">
          {t('processList.title')}
        </h2>
        <div className="flex flex-none items-center gap-0.5">
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
            whileTap={{ scale: 0.96 }}
            transition={SPRING_TAP}
            className="rounded px-2 py-1 text-[11px] text-text-muted outline-none transition-colors hover:bg-surface-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {t('processList.refresh')}
          </motion.button>
        </div>
      </div>

      {sessions.length > 0 && (
        <div className="relative flex-none border-b border-line">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
            className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-text-muted"
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
            className="w-full border-b border-transparent bg-transparent py-2 pl-9 pr-3 text-[12px] text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent/60"
          />
        </div>
      )}

      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {visibleSessions.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
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
            <p className="text-[11px] leading-relaxed text-text-muted">
              {query.trim() === '' ? t('processList.empty') : t('processList.noMatch')}
              {query.trim() === '' && (
                <>
                  <br />
                  <span>{t('processList.emptyHint')}</span>
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
              <motion.div
                key={session.pid}
                variants={item}
                className="group/row relative border-b border-line last:border-b-0"
              >
                <SelectionMark selected={isSelected} />
                <div
                  className={`flex items-center gap-1 pr-1.5 ${
                    // Not `bg-accent-muted/50`: `--accent-muted` is a plain
                    // rgba() with its alpha already baked in, and Tailwind
                    // cannot apply a modifier to that — it drops the class and
                    // the row quietly ends up with no wash at all. The accent
                    // itself is an RGB mirror, so an opacity modifier on it is
                    // the one form that actually compiles.
                    isSelected ? 'bg-accent/[0.07] dark:bg-accent/[0.12]' : ''
                  }`}
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      // Ctrl+click adds to the selection so several processes
                      // can be routed in one go.
                      if (e.ctrlKey || e.metaKey) {
                        toggleProcessSelection(session.pid);
                      } else {
                        selectProcess(session.pid);
                      }
                    }}
                    title={t('processList.multiSelectHint')}
                    className={`min-w-0 flex-1 py-1.5 pl-4 pr-1 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60 ${
                      isSelected ? '' : 'hover:bg-surface-hover'
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      <span
                        className={`truncate text-[13px] ${
                          isSelected
                            ? 'font-medium text-text-primary'
                            : routedCountForPid > 0
                              ? 'text-text-primary'
                              : 'text-text-secondary'
                        }`}
                      >
                        {session.exe_name}
                      </span>
                      {selectedPids.length > 1 && isSelected && (
                        <span className="flex-none font-mono text-[10px] text-accent">
                          #{selectedPids.indexOf(session.pid) + 1}
                        </span>
                      )}
                    </span>
                    {/* PID, and — only for a program that is actually routed —
                        where its sound goes. An unrouted program plays through
                        the system default, which is the same device for every
                        row: repeating it down the list says nothing and makes
                        every program look like it is being sent somewhere. */}
                    <span className="flex items-center gap-1 font-mono text-[10px] tabular-nums text-text-muted">
                      <span className="flex-none">PID {session.pid}</span>
                      {routedCountForPid > 0 && deviceName !== null && (
                        <>
                          <span aria-hidden="true" className="flex-none opacity-50">
                            ·
                          </span>
                          <span
                            className="truncate font-sans"
                            title={t('processList.associatedDevice', { device: deviceName })}
                          >
                            {deviceName}
                          </span>
                          {routedCountForPid > 1 && (
                            <span className="flex-none text-accent">
                              +{routedCountForPid - 1}
                            </span>
                          )}
                        </>
                      )}
                    </span>
                  </button>
                  {/* Status, right-aligned: one accent dot for "this program's
                      sound is going somewhere other than the system default".
                      How many devices it went to is written on the line above,
                      next to the one it names, instead of being counted twice. */}
                  <AnimatePresence>
                    {routedCountForPid > 0 && (
                      <motion.span
                        initial={{ opacity: 0, scale: 0.6 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.6 }}
                        transition={SPRING_TAP}
                        title={t('processList.routedBadge', { n: routedCountForPid })}
                        className="flex flex-none items-center"
                      >
                        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
                      </motion.span>
                    )}
                  </AnimatePresence>
                  <AnimatePresence>
                    {routedCountForPid > 0 && (
                      <motion.span
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={SPRING_TAP}
                        className="flex flex-none"
                      >
                        {/* Stopping sends the program's sound back to the
                            system default — harmless, but baffling when it
                            happens under an accidental click, so it asks first,
                            the same way the stop-all in the header does. The
                            button itself waits for a hover: a cross sitting on
                            every routed row makes the list read as a list of
                            things waiting to be deleted. */}
                        <span className="opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100">
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
                        </span>
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
