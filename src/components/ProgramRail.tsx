import { useDeferredValue, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import type { AudioSession } from '@/lib/types';
import { ConfirmButton } from '@/components/ui/ConfirmButton';
import { ProcessIcon } from '@/components/ui/ProcessIcon';
import { Ring } from '@/components/ui/Ring';
import { useLiveness } from '@/hooks/useLiveness';
import { FADE, SPRING_GLIDE, SPRING_TAP } from '@/lib/motion';
import { useRouterStore } from '@/stores/routerStore';

/**
 * The app list: every programme making sound, and where each one is playing.
 *
 * Rows are separated by nothing but air and their own shapes — a hairline under
 * each row would be the third line on every screen of this app, and a list
 * whose rows are already separated does not need to be ruled as well. Selection
 * is the row lighting up, not an outline drawn around it.
 *
 * Where a programme's sound goes is written on its own row, which is the reason
 * the row exists at all: unrouted programmes all play through the same system
 * default, so naming it there would be a column of identical text. Say nothing
 * until there is something to say.
 */
export function ProgramRail() {
  const { t } = useTranslation();
  const devices = useRouterStore((s) => s.devices);
  const sessions = useRouterStore((s) => s.sessions);
  const selectedPids = useRouterStore((s) => s.selectedPids);
  const routedPids = useRouterStore((s) => s.routedPids);
  const defaultDeviceId = useRouterStore((s) => s.defaultDeviceId);
  const soundingPids = useRouterStore((s) => s.soundingPids);
  const selectProcess = useRouterStore((s) => s.selectProcess);
  const toggleProcessSelection = useRouterStore((s) => s.toggleProcessSelection);
  const stopRoute = useRouterStore((s) => s.stopRoute);
  const stopAllRoutes = useRouterStore((s) => s.stopAllRoutes);
  const refreshSessions = useRouterStore((s) => s.refreshSessions);

  // The one loop this list is allowed to run — a ring pulsing because a
  // programme is making sound — waits on somebody being able to see it. A
  // background window owes nobody a repaint.
  const liveness = useLiveness();

  const routedCount = Object.keys(routedPids).length;
  const [query, setQuery] = useState('');

  /**
   * What the list is filtered by, one beat behind what was typed.
   *
   * A keystroke has to appear in the field on the keystroke; the list behind
   * it does not. Every character re-filters and re-sorts every session and
   * re-renders a row per one, and each of those rows measures its own box
   * because rows travel to their new places — so typing used to race the list
   * inside a single commit, and the character arrived with the work.
   *
   * Deferring the value lets the keystroke paint on its own and fits the list
   * in around it. The list and the words under it both read the deferred
   * value, so the two never disagree about what is on screen for a beat.
   */
  const filter = useDeferredValue(query);
  const searching = filter.trim() !== '';

  /** The rows on screen: filtered by what was typed, routed programmes first.
   *  A stable sort keeps the enumeration order within each group, so rows do
   *  not reshuffle among themselves while audio comes and goes. */
  const visibleSessions = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matches = (s: AudioSession) =>
      s.exe_name.toLowerCase().includes(q) ||
      (s.display_name ?? '').toLowerCase().includes(q);
    const filtered = q ? sessions.filter(matches) : sessions;
    return [...filtered].sort(
      (a, b) => (routedPids[b.pid]?.length ?? 0) - (routedPids[a.pid]?.length ?? 0),
    );
  }, [sessions, filter, routedPids]);

  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of devices) map.set(d.id, d.name);
    return map;
  }, [devices]);

  const playsThrough = (pid: number): string | null => {
    const id = routedPids[pid]?.[0] ?? defaultDeviceId;
    if (id === undefined || id === null) return null;
    return nameById.get(id) ?? null;
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex h-11 flex-none items-center justify-between gap-1 px-3">
        <h2 className="truncate text-[11px] font-semibold text-text-secondary">
          {t('rail.title')}
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
                {/* Stops every routed programme at once, so it asks first: one
                    click here otherwise takes the audio of programmes the user
                    was not even looking at. */}
                <ConfirmButton
                  variant="icon"
                  label={t('rail.stopAll')}
                  confirmLabel={t('rail.stopAllConfirm')}
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
            className="squircle rounded-seg px-2 py-1 text-[11px] text-text-muted outline-none transition-colors hover:bg-surface-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {t('rail.refresh')}
          </motion.button>
        </div>
      </div>

      {sessions.length > 0 && (
        <div className="relative flex-none px-3 pb-2">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
            className="pointer-events-none absolute left-6 top-1/2 -translate-y-1/2 text-text-muted"
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
            placeholder={t('rail.search')}
            aria-label={t('rail.search')}
            className="squircle w-full rounded-full border border-transparent bg-transparent py-2 pl-8 pr-3 text-[12px] text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-glass-border focus:bg-glass"
          />
        </div>
      )}

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={FADE}
        className="relative min-h-0 flex-1 overflow-y-auto px-2 pb-2"
      >
        {/* The "no programmes" placeholder is out of the flow on purpose. It
            used to share one AnimatePresence with the rows, so a list filling
            up measured its rows underneath a card that was already leaving —
            and framer-motion then spent a second sliding them up the gap that
            card had left, which is most of the rail when the list holds two
            apps. Absolute here it weighs nothing and simply cross-fades. */}
        <AnimatePresence initial={false}>
          {visibleSessions.length === 0 && (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={FADE}
              className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 py-10 text-center"
            >
              {!searching && (
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
                {searching ? t('rail.noMatch') : t('rail.empty')}
                {!searching && (
                  <>
                    <br />
                    <span>{t('rail.emptyHint')}</span>
                  </>
                )}
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Rows come and go as programmes start and stop making sound, and they
            reorder whenever one of them is routed — routed ones lead. Both are
            worth watching, so each row fades where it stands and *travels* to
            its new place rather than being redrawn there. */}
        <AnimatePresence initial={false}>
        {visibleSessions.map((session) => {
            const targets = routedPids[session.pid] ?? [];
            const isSelected = selectedPids.includes(session.pid);
            const isSubject = selectedPids[0] === session.pid;
            const joined = isSelected && !isSubject;
            const through = playsThrough(session.pid);
            const sounding = soundingPids[session.pid] === true && targets.length > 0 && liveness;
            // The window names the program something a person can read; the exe
            // is the identity this app remembers and routes by, so it stays on
            // the record line whenever the display name differs from it.
            const name = session.display_name ?? session.exe_name;
            const exeDiffers =
              session.display_name !== undefined &&
              session.display_name !== null &&
              session.display_name.toLowerCase() !== session.exe_name.toLowerCase();

            return (
              <motion.div
                key={session.pid}
                layout
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={FADE}
                className={`group/row squircle relative mb-1 flex items-center rounded-full px-2 py-1.5 transition-colors ${
                  isSelected ? '' : 'hover:bg-surface-hover'
                }`}
              >
                {/* The selection is one object that moves, not a class that is
                    switched on: picking another programme slides the pane off
                    one row and onto the next, which is the only cue that says
                    "the stage switched to this one" without words. The rows
                    added to the batch get a quieter wash — several programmes
                    are going to be changed at once, and only one of them is the
                    one being shown. Both are capsules: a row of a liquid-glass
                    list is a pill, and the glass that marks it is the same pill
                    sliding between them. */}
                {isSubject ? (
                  <motion.span
                    layoutId="rail-selection"
                    transition={SPRING_GLIDE}
                    aria-hidden="true"
                    className="glass-strong squircle pointer-events-none absolute inset-0 rounded-full"
                  />
                ) : joined ? (
                  <span
                    aria-hidden="true"
                    className="squircle pointer-events-none absolute inset-0 rounded-full bg-accent/[0.07]"
                  />
                ) : null}

                <div className="relative flex min-w-0 flex-1 items-center gap-2">
                <Ring
                  size={14}
                  tone={targets.length > 0 ? 'main' : 'idle'}
                  live={sounding}
                  className="transition-transform group-hover/row:scale-110"
                />

                <button
                  type="button"
                  onClick={(event) => {
                    // Ctrl+click adds to the batch the same way the + on the row
                    // does; either gesture is fine, both are explicit. Nothing
                    // here depends on the user knowing a modifier exists.
                    if (event.ctrlKey || event.metaKey) {
                      toggleProcessSelection(session.pid);
                    } else {
                      selectProcess(session.pid);
                    }
                  }}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                >
                  {/* The executable's own icon, in a slot that is its size
                      whether the pixels have arrived or not. */}
                  <ProcessIcon exeName={session.exe_name} name={name} size={16} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-text-primary">
                      {name}
                    </span>
                    {/* PID, the exe it really is when the window names it
                        differently, and — only once something has actually been
                        routed — where its sound goes. */}
                    <span className="block truncate font-mono text-[9.5px] tabular-nums text-text-muted">
                      {exeDiffers && (
                        <>
                          {session.exe_name}
                          <span aria-hidden="true" className="opacity-50">
                            {' · '}
                          </span>
                        </>
                      )}
                      {t('rail.pid', { pid: session.pid })}
                      {targets.length > 0 && through !== null && (
                        <>
                          <span aria-hidden="true" className="opacity-50">
                            {' · '}
                          </span>
                          <span className="font-sans">{through}</span>
                          {targets.length > 1 && (
                            <span className="text-accent"> +{targets.length - 1}</span>
                          )}
                        </>
                      )}
                    </span>
                  </span>
                </button>

                {/* Include this one in the change. Replacing Ctrl+click with a
                    control someone can see is the whole point: a batch of five
                    programmes is not something a user should discover they made. */}
                {!isSubject && (
                  <MiniToggle
                    pressed={joined}
                    label={t('rail.alsoHint')}
                    onClick={() => toggleProcessSelection(session.pid)}
                  />
                )}

                {targets.length > 0 && (
                  <span className="flex flex-none scale-75 items-center opacity-0 transition duration-200 group-hover/row:scale-100 group-hover/row:opacity-100 group-focus-within/row:scale-100 group-focus-within/row:opacity-100">
                    {/* Stopping sends the programme's sound back to the system
                        default — harmless, but baffling when it happens under an
                        accidental click, so it asks first. */}
                    <ConfirmButton
                      variant="icon"
                      label={t('rail.stopRoute')}
                      confirmLabel={t('rail.stopRouteConfirm')}
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
                )}
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

/** The small circle that adds a programme to the batch being changed. */
function MiniToggle({
  pressed,
  label,
  onClick,
}: {
  pressed: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      title={label}
      aria-label={label}
      whileTap={{ scale: 0.82 }}
      whileHover={{ scale: 1.12 }}
      transition={SPRING_TAP}
      className={`squircle flex h-5 w-5 flex-none items-center justify-center rounded-full border text-[11px] leading-none outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60 ${
        pressed
          ? 'border-accent bg-accent text-accent-ink'
          : 'border-glass-border bg-glass text-text-muted opacity-0 hover:text-accent group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100'
      }`}
    >
      {/* The plus does not turn into a tick, it is replaced by one: the mark
          has to be legible at 9 px, and a morph at that size reads as a
          smudge. */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={pressed ? 'on' : 'off'}
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.5, opacity: 0 }}
          transition={SPRING_TAP}
          className="flex"
        >
          {pressed ? (
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <polyline points="1.5 5.5 4 8 8.5 2.5" />
            </svg>
          ) : (
            <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
              <line x1="5" y1="1.5" x2="5" y2="8.5" />
              <line x1="1.5" y1="5" x2="8.5" y2="5" />
            </svg>
          )}
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
}
