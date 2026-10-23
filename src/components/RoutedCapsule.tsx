import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { ConfirmButton } from '@/components/ui/ConfirmButton';
import { ProcessIcon } from '@/components/ui/ProcessIcon';
import { Ring } from '@/components/ui/Ring';
import { Tooltip } from '@/components/ui/Tooltip';
import { useLiveness } from '@/hooks/useLiveness';
import { MAIN_THREAD_TRANSFORM, SPRING_GLIDE, SPRING_TAP } from '@/lib/motion';
import { isEditableTarget } from '@/lib/productionGuards';
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

/** The cap on the sheet's list, in CSS pixels: the sheet's own surface measure
 *  (the family of its `w-[320px]`), not board geometry — `lib/stage.ts` sizes
 *  the board's 52px rows, and these are the capsule's own 28px ones. Even at
 *  the app's minimum window height the pill leaves more than this above it, so
 *  the sheet's cut always lands on a row inside the box and the fade below is
 *  what says there is more under it. */
const SHEET_LIST_MAX_PX = 280;

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
  // The pill's own ring, as one boolean: subscribing to the whole sounding
  // table would re-render the capsule — pill and open panel alike — every
  // time any unrelated process in the system flips play/pause. A primitive
  // snapshot only re-renders when the answer actually changes. Sounding is
  // read per program: the process making the sound is often a sibling of the
  // one holding the route.
  const anySounding = useRouterStore((s) => {
    for (const session of s.sessions) {
      const ids = s.routedPids[session.pid];
      if (ids === undefined || ids.length === 0) continue;
      if (s.soundingExes[session.exe_name.toLowerCase()] === true) return true;
    }
    return false;
  });

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** Whether the capped list has more rows above or below what is visible —
   *  the same two background fades the board's panels use at their cut edge. */
  const [listFade, setListFade] = useState({ up: false, down: false });
  const measureListFade = () => {
    const el = listRef.current;
    const up = el !== null && el.scrollTop > 0.5;
    const down = el !== null && el.scrollTop + el.clientHeight < el.scrollHeight - 0.5;
    setListFade((prev) => (prev.up === up && prev.down === down ? prev : { up, down }));
  };

  // Walk the session list, not the route table: a programme on its way out can
  // still carry a route for a breath, and a row without a name or an icon has
  // nothing to show for it. The Status page walks the list the same way. Each
  // row reads its own sounding state where it is rendered (`CapsuleRow`), for
  // the same reason the pill reads its as a boolean above.
  const rows: RoutedRow[] = [];
  for (const session of sessions) {
    const ids = routedPids[session.pid];
    if (ids === undefined || ids.length === 0) continue;
    rows.push({
      pid: session.pid,
      name: session.display_name ?? session.exe_name,
      exeName: session.exe_name,
      devices: ids.map((id) => devices.find((d) => d.id === id)?.name ?? t('routed.deviceGone')),
    });
  }

  // The last row stopping from inside the panel takes the pill with it — an
  // empty list would be a panel asking to manage nothing. The keyboard comes
  // back to the pill with it: the row that was pressed no longer exists.
  useEffect(() => {
    if (open && rows.length === 0) {
      setOpen(false);
      pillRef.current?.focus();
    }
  }, [open, rows.length]);

  // Opening walks into the panel. Its rows sit *before* the pill in the
  // document — the sheet hangs above the button it belongs to — so a Tab from
  // the pill would pass every routed program on its way out.
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>('button')?.focus();
  }, [open]);

  // A routed list longer than the sheet can show must not be clipped by the
  // window's top: the rows scroll inside the sheet, and the fades say which
  // side still has more. Measured when the sheet mounts and whenever the list
  // grows or shrinks; every scroll — the user's own or a focused row the
  // browser brings into view — re-measures through `measureListFade`.
  useEffect(() => {
    if (open) measureListFade();
  }, [open, rows.length]);

  // Escape and outside-pointerdown follow the panel's visibility, exactly the
  // way the stage's pickers do it: a standing listener would swallow the key
  // for the whole session. The key is also left to a control that owns it — an
  // armed ✕ in one of these rows answers Escape itself, and taking the whole
  // panel down on that press would spend a question the user was looking at.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (isEditableTarget(event.target)) return;
      event.stopPropagation();
      setOpen(false);
      // The panel is gone; the pill it hung off is where the keyboard was, and
      // where it belongs — outside presses are their own answer and keep it.
      pillRef.current?.focus();
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

  return (
    // Anchored above the band the tuning strip takes when a row is being
    // tuned. The strip no longer stands there, but it still takes that band
    // when it appears, so the pill keeps clear of it rather than being painted
    // over by it. Nothing in the layout is displaced by it.
    <div
      ref={rootRef}
      className="pointer-events-none absolute inset-x-0 bottom-[56px] z-30 flex justify-center px-4"
    >
      <div className="pointer-events-auto relative">
        <AnimatePresence>
          {open && (
            <motion.div
              key="routed"
              ref={panelRef}
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
              className="cc absolute bottom-full left-1/2 mb-2 w-[320px] rounded-card border border-line-strong bg-surface p-1.5"
            >
              <div className="px-2 pb-1 pt-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-text-muted">
                {t('routed.title')}
              </div>
              {/* The rows scroll inside a capped box; the two background fades
                  are the board panels' own language for *that side still has
                  rows*, painted on the sheet's surface colour and only lit
                  while there is something on that side to reach. */}
              <div className="relative">
                <div
                  ref={listRef}
                  onScroll={measureListFade}
                  className="flex flex-col overflow-y-auto"
                  style={{ maxHeight: SHEET_LIST_MAX_PX }}
                >
                  {rows.map((row) => (
                    <CapsuleRow
                      key={row.pid}
                      row={row}
                      liveness={liveness}
                      onNavigate={() => setOpen(false)}
                    />
                  ))}
                </div>
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 top-0 h-4 bg-gradient-to-b from-surface to-transparent transition-opacity duration-200"
                  style={{ opacity: listFade.up ? 1 : 0 }}
                />
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-surface to-transparent transition-opacity duration-200"
                  style={{ opacity: listFade.down ? 1 : 0 }}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <Tooltip label={open ? '' : t('routed.tooltip')}>
          <motion.button
            type="button"
            ref={pillRef}
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

/**
 * One row of the open panel. Its ring subscribes to its own program's voice —
 * per executable, the way the pill reads — so a sibling process starting or
 * stopping anywhere else in the system repaints nothing here.
 */
function CapsuleRow({
  row,
  liveness,
  onNavigate,
}: {
  row: RoutedRow;
  liveness: boolean;
  onNavigate: () => void;
}) {
  const { t } = useTranslation();
  const selectProcess = useRouterStore((s) => s.selectProcess);
  const stopRoute = useRouterStore((s) => s.stopRoute);
  const exeKey = row.exeName.toLowerCase();
  const sounding = useRouterStore((s) => s.soundingExes[exeKey] === true);
  const first = row.devices[0] ?? '';
  return (
    <div
      data-routed-row={row.pid}
      className="flex items-center gap-2 rounded-seg px-2 py-1.5 transition-colors hover:bg-surface-hover"
    >
      <Ring tone="main" size={12} live={sounding && liveness} />
      <ProcessIcon exeName={row.exeName} name={row.name} size={16} />
      {/* The name is the door, not a lever: it opens that
          programme's own board, where its levers already live.
          Every number keeps exactly one place to be changed. */}
      <button
        type="button"
        onClick={() => {
          selectProcess(row.pid);
          onNavigate();
        }}
        title={t('routed.tune', { name: row.name })}
        aria-label={t('routed.tune', { name: row.name })}
        className="pressable min-w-0 flex-1 truncate text-left text-[12px] font-semibold text-text-primary outline-none hover:text-accent focus-visible:text-accent"
      >
        {row.name}
      </button>
      <span className="max-w-[92px] flex-none truncate text-xs text-text-muted">
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
}
