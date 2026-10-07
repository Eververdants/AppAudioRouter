import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { ConfirmButton } from '@/components/ui/ConfirmButton';
import { ProcessIcon } from '@/components/ui/ProcessIcon';
import { Ring } from '@/components/ui/Ring';
import { Tooltip } from '@/components/ui/Tooltip';
import { useLiveness } from '@/hooks/useLiveness';
import { MAIN_THREAD_TRANSFORM, SPRING_GLIDE, SPRING_TAP } from '@/lib/motion';
import { useRouterStore } from '@/stores/routerStore';

/**
 * One row of the expanded capsule: a routed programme and where it plays now.
 */
interface RoutedRow {
  pid: number;
  name: string;
  exeName: string;
  /** The device names the route reaches, in the order the route plays them. */
  devices: string[];
  sounding: boolean;
}

/** The way back for one row: the same ✕ the rail's routed rows carry. */
const STOP_GLYPH = (
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
);

/**
 * The routed capsule: one pill that counts every live route, and the list it
 * opens — one row per routed programme, each with its own way out.
 *
 * The board answers for the programme being looked at; this answers for all of
 * them at once, wherever on the board each one sits. It is the compact form of
 * the old action dock: a capsule, not a bar, floating over the work area. What
 * it offers is deliberately one-sided — a route is stopped from here, never
 * started (starting belongs to the hub, where the plan is), and a row's name is
 * a door to that programme's own board rather than a second set of levers, so
 * every number still has exactly one place it can be changed in.
 *
 * The pill exists only while something is routed: a management surface for a
 * empty state is noise. Rows report liveness through the shared gate — a
 * background or unfocused window paints nothing that moves.
 */
export function RoutedCapsule() {
  const { t } = useTranslation();
  const liveness = useLiveness();
  const devices = useRouterStore((s) => s.devices);
  const sessions = useRouterStore((s) => s.sessions);
  const routedPids = useRouterStore((s) => s.routedPids);
  const soundingPids = useRouterStore((s) => s.soundingPids);
  const selectProcess = useRouterStore((s) => s.selectProcess);
  const stopRoute = useRouterStore((s) => s.stopRoute);

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Walk the session list, not the route table: a programme on its way out can
  // still carry a route for a breath, and a row without a name or an icon has
  // nothing to show for it. The briefing reads the list the same way.
  const rows: RoutedRow[] = [];
  for (const session of sessions) {
    const ids = routedPids[session.pid];
    if (ids === undefined || ids.length === 0) continue;
    rows.push({
      pid: session.pid,
      name: session.display_name ?? session.exe_name,
      exeName: session.exe_name,
      devices: ids.map((id) => devices.find((d) => d.id === id)?.name ?? id),
      sounding: soundingPids[session.pid] === true,
    });
  }

  // The last row stopping from inside the panel takes the pill with it — an
  // empty list would be a panel asking to manage nothing.
  useEffect(() => {
    if (open && rows.length === 0) setOpen(false);
  }, [open, rows.length]);

  // Escape and outside-pointerdown follow the panel's visibility, exactly the
  // way the briefing bubble and the stage's picker do it: a standing listener
  // would swallow the search box's Escape for the whole session.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  if (rows.length === 0) return null;

  const anySounding = rows.some((row) => row.sounding);

  return (
    // Anchored above the board's tuning strip — the band the briefing's corner
    // also floats in — and centred, where the dock that once applied routes
    // used to sit. Nothing in the layout is displaced by it.
    <div
      ref={rootRef}
      className="pointer-events-none absolute inset-x-0 bottom-[56px] z-30 flex justify-center px-4"
    >
      <div className="pointer-events-auto relative">
        <AnimatePresence>
          {open && (
            <motion.div
              key="routed"
              role="group"
              aria-label={t('routed.title')}
              data-routed-panel
              initial={{ opacity: 0, y: 8, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.98 }}
              transition={SPRING_GLIDE}
              // The centring rides the transform rather than the class: Motion
              // writes an inline `transform` on every frame of this panel's
              // travel, and an inline style outranks the class rule, so a
              // `-translate-x-1/2` in the className would simply not be there —
              // leaving the sheet half its width (160 px) right of the pill it
              // hangs off, and off the edge of the window besides.
              transformTemplate={(_, generated) => `translateX(-50%) ${generated}`}
              className="bg-surface border-line-strong cc absolute bottom-full left-1/2 mb-2 w-[320px] rounded-card border p-1.5"
            >
              <div className="px-2 pb-1 pt-1.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-text-muted">
                {t('routed.title')}
              </div>
              <div className="flex flex-col">
                {rows.map((row) => {
                  const first = row.devices[0] ?? '';
                  return (
                    <div
                      key={row.pid}
                      data-routed-row={row.pid}
                      className="hover:bg-surface-hover flex items-center gap-2 rounded-seg px-2 py-1.5 transition-colors"
                    >
                      <Ring tone="main" size={12} live={row.sounding && liveness} />
                      <ProcessIcon exeName={row.exeName} name={row.name} size={16} />
                      {/* The name is the door, not a lever: it opens that
                          programme's own board, where its levers already live.
                          Every number keeps exactly one place to be changed. */}
                      <button
                        type="button"
                        onClick={() => {
                          selectProcess(row.pid);
                          setOpen(false);
                        }}
                        title={t('routed.tune', { name: row.name })}
                        aria-label={t('routed.tune', { name: row.name })}
                        className="min-w-0 flex-1 truncate text-left text-[12px] font-semibold text-text-primary outline-none hover:text-accent focus-visible:text-accent"
                      >
                        {row.name}
                      </button>
                      <span className="max-w-[92px] flex-none truncate text-[10px] text-text-muted">
                        {row.devices.length === 1 ? first : `${first} +${row.devices.length - 1}`}
                      </span>
                      <ConfirmButton
                        variant="icon"
                        label={t('rail.stopRoute')}
                        confirmLabel={t('rail.stopRouteConfirm')}
                        onConfirm={() => void stopRoute(row.pid)}
                        icon={STOP_GLYPH}
                      />
                    </div>
                  );
                })}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <Tooltip label={open ? '' : t('routed.tooltip')}>
          <motion.button
            type="button"
            data-routed-capsule
            aria-expanded={open}
            aria-label={t('routed.tooltip')}
            onClick={() => setOpen((value) => !value)}
            whileTap={{ scale: 0.94 }}
            whileHover={{ scale: 1.05 }}
            transition={SPRING_TAP}
            transformTemplate={MAIN_THREAD_TRANSFORM}
            className={`flex h-8 items-center gap-1.5 rounded-full border px-3 text-[11.5px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60 ${
              open
                ? 'border-accent/60 bg-accent-muted text-accent'
                : 'border-line bg-surface text-text-secondary hover:text-text-primary'
            }`}
          >
            <Ring tone="main" size={12} live={anySounding && liveness} />
            {t('routed.capsule', { n: rows.length })}
          </motion.button>
        </Tooltip>
      </div>
    </div>
  );
}
