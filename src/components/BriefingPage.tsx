import { useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { ProcessIcon } from '@/components/ui/ProcessIcon';
import { Ring } from '@/components/ui/Ring';
import { useLiveness } from '@/hooks/useLiveness';
import { useProgramRoutes } from '@/hooks/useProgramRoutes';
import { FADE, MAIN_THREAD_TRANSFORM, SPRING_GLIDE } from '@/lib/motion';
import { alreadyApplied } from '@/lib/stage';
import { feedLiveness, useRouterStore } from '@/stores/routerStore';

/** One destination, as the page draws it. */
interface Destination {
  key: string;
  name: string;
  /** Which colour the chip wears: the role colours, nothing else. */
  role: 'primary' | 'copy' | 'feed';
  /** Feed chips only: whether the feed is moving, held, or has no carrier. */
  feedState?: 'live' | 'suspended' | 'no-carrier';
}

/** One program, and everywhere its sound is going right now. */
interface Card {
  pid: number;
  name: string;
  exeName: string;
  destinations: Destination[];
}

/** The colour of a role, as a CSS variable the chip's dot wears. */
const ROLE_COLOR: Record<Destination['role'], string> = {
  primary: 'var(--type-primary)',
  copy: 'var(--type-mirror)',
  feed: 'var(--type-feed)',
};

/** The little wire between a program and its destinations. Not animated: it is
 *  a drawing of a fact, and the fact is stated by the chips at its end. */
function Connector() {
  return (
    <svg
      width="30"
      height="12"
      viewBox="0 0 30 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="flex-none text-text-muted"
    >
      <line x1="0" y1="6" x2="22" y2="6" />
      <polyline points="18 3 22 6 18 9" />
    </svg>
  );
}

/** One destination chip: a role dot, the device's name, and the role in words.
 *  It fades where it stands and travels to its new place when a sibling joins
 *  or leaves — the same reading the rail's rows carry. */
function Chip({ destination, roleWord }: { destination: Destination; roleWord: string }) {
  // A feed that is not moving is still a destination, but the chip says so:
  // dimming it is the page's way of holding it apart from the ones that are.
  const held = destination.feedState !== undefined && destination.feedState !== 'live';
  return (
    <motion.span
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={FADE}
      transformTemplate={MAIN_THREAD_TRANSFORM}
      className={`inline-flex items-center gap-1.5 rounded-full border border-line bg-surface py-0.5 pl-2 pr-2.5 ${
        held ? 'opacity-70' : ''
      }`}
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 flex-none rounded-full"
        style={{ background: ROLE_COLOR[destination.role] }}
      />
      <span className="max-w-[150px] truncate text-[11.5px] text-text-secondary">
        {destination.name}
      </span>
      <span
        className={`text-[9.5px] font-semibold uppercase tracking-[0.06em] ${
          destination.role === 'feed' ? 'text-type-feed' : 'text-text-muted'
        }`}
      >
        {roleWord}
      </span>
    </motion.span>
  );
}

/**
 * The standing answer to "where is sound going right now", as a page.
 *
 * The board answers for one programme at a time; this answers for all of them,
 * and it answers *visually* — every routed programme is a row, and the chips to
 * the right of its arrow are the destinations, in the order the sound reaches
 * them, wearing the same role colours the board uses. Reading it takes no
 * vocabulary: a row with one chip is going one place, a row with three is going
 * three, and a programme that is not on the page is following the system
 * default like everything else.
 *
 * It reports; it never acts. What changes a route lives where the route is
 * drawn, so the only action offered here is the pointer's own way back: the
 * **programme's** name is a door to its board. The destination chips are labels,
 * not controls — one place to change a route, and this is not it.
 */
export function BriefingPage({ onOpenBoard }: { onOpenBoard: () => void }) {
  const { t } = useTranslation();
  const liveness = useLiveness();
  const devices = useRouterStore((s) => s.devices);
  const sessions = useRouterStore((s) => s.sessions);
  const routedPids = useRouterStore((s) => s.routedPids);
  const routesByPid = useProgramRoutes();
  const defaultDeviceId = useRouterStore((s) => s.defaultDeviceId);
  const selectedPids = useRouterStore((s) => s.selectedPids);
  const selectedDeviceIds = useRouterStore((s) => s.selectedDeviceIds);
  const feeds = useRouterStore((s) => s.feeds);
  const feedCarrier = useRouterStore((s) => s.feedCarrier);

  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const device of devices) map.set(device.id, device.name);
    return map;
  }, [devices]);

  const defaultName =
    defaultDeviceId !== null ? (nameById.get(defaultDeviceId) ?? defaultDeviceId) : null;

  const { cards, following } = useMemo(() => {
    // The route table is keyed by the process that holds the route — one per
    // executable, written to the lowest pid — so reading it by the session's own
    // pid is what keeps this page at **one row per program**: a browser's dozen
    // processes yield one row, not a dozen. (The folded, per-program view is for
    // callers asking about "this process's program"; here the question is "which
    // programs are redirected", and the owner is the single answer.) `following`
    // is counted the same way — per executable — so a routed program's siblings
    // are not mistaken for programs still on the default.
    const redirectedExes = new Set<string>();
    const cards: Card[] = [];
    for (const session of sessions) {
      const key = session.exe_name.toLowerCase();
      const ids = routedPids[session.pid] ?? [];
      const targetPids = feeds[session.pid] ?? [];
      if (ids.length === 0 && targetPids.length === 0) continue;
      redirectedExes.add(key);
      const destinations: Destination[] = ids.map((id, index) => ({
        key: `dev:${id}`,
        name: nameById.get(id) ?? t('briefingPage.deviceGone'),
        role: index === 0 ? 'primary' : 'copy',
      }));
      for (const targetPid of targetPids) {
        const target = sessions.find((s) => s.pid === targetPid);
        if (target === undefined) continue;
        destinations.push({
          key: `feed:${targetPid}`,
          name: target.display_name ?? target.exe_name,
          role: 'feed',
          // The same reading the board's feed cards use: a device route takes
          // the source's render slot, so the feed is held rather than moving.
          feedState: feedLiveness(session.pid, feedCarrier, routedPids, sessions),
        });
      }
      cards.push({
        pid: session.pid,
        name: session.display_name ?? session.exe_name,
        exeName: session.exe_name,
        destinations,
      });
    }
    const allExes = new Set(sessions.map((session) => session.exe_name.toLowerCase()));
    return { cards, following: allExes.size - redirectedExes.size };
  }, [sessions, routedPids, feeds, nameById, feedCarrier, t]);

  // Changes staged on the board that have not landed: the one thing this page
  // cannot show, because the page reports what is happening and those are not.
  // The plan's own order — the same one the apply will land.
  const staged = selectedDeviceIds;
  const pending = staged.length > 0 && !alreadyApplied(staged, selectedPids, routesByPid);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-8 py-7">
        {/* The baseline every unredirected program is on, stated once and
            first: the page is about the exceptions, so the rule comes before
            them. */}
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={SPRING_GLIDE}
          transformTemplate={MAIN_THREAD_TRANSFORM}
          className="flex items-center gap-3 rounded-card border border-line bg-surface-sunken px-4 py-3"
        >
          <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full border border-line-strong text-text-muted">
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 10v4h3l4 3V7L6 10H3z" />
              <path d="M15 9a4 4 0 0 1 0 6" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] font-medium text-text-primary">
              {defaultName ?? t('briefingPage.defaultFallback')}
            </div>
            <div className="truncate text-[11px] text-text-muted">
              {t('briefingPage.defaultHint')}
            </div>
          </div>
          <span className="flex-none text-[11px] tabular-nums text-text-muted">
            {t('briefingPage.following', { n: following })}
          </span>
        </motion.div>

        {cards.length === 0 ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={FADE}
            transformTemplate={MAIN_THREAD_TRANSFORM}
            className="flex flex-col items-center gap-2 rounded-card border border-dashed border-line-strong px-6 py-12 text-center"
          >
            <Ring tone="idle" size={18} />
            <p className="text-[12.5px] font-medium text-text-secondary">
              {t('briefingPage.empty')}
            </p>
            <p className="max-w-[44ch] text-[11px] leading-relaxed text-text-muted">
              {defaultName !== null
                ? t('briefingPage.emptyHint', { device: defaultName })
                : t('briefingPage.emptyNoDevice')}
            </p>
          </motion.div>
        ) : (
          <div className="flex flex-col gap-2.5">
            <AnimatePresence initial={false}>
              {cards.map((card) => (
                <BriefingCard
                  key={card.pid}
                  card={card}
                  liveness={liveness}
                  onOpenBoard={onOpenBoard}
                />
              ))}
            </AnimatePresence>
          </div>
        )}

        <AnimatePresence initial={false}>
          {pending && (
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={FADE}
              transformTemplate={MAIN_THREAD_TRANSFORM}
              className="rounded-ctl border border-accent/40 bg-accent-muted px-3.5 py-2.5 text-[11.5px] leading-relaxed text-accent"
            >
              {t('briefingPage.staged')}
            </motion.p>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/**
 * One program's row on the page. Its ring and its "quiet" word subscribe to
 * its own program's voice — per executable, the way the page has always read
 * it, sibling processes included — so a play/pause flip elsewhere in the
 * system repaints one row at most, never the whole page (chips included,
 * each of which re-measures itself for its layout travel).
 */
function BriefingCard({
  card,
  liveness,
  onOpenBoard,
}: {
  card: Card;
  liveness: boolean;
  onOpenBoard: () => void;
}) {
  const { t } = useTranslation();
  const selectProcess = useRouterStore((s) => s.selectProcess);
  const exeKey = card.exeName.toLowerCase();
  const sounding = useRouterStore((s) => s.soundingExes[exeKey] === true);

  /** The word a chip wears, which for a feed is its own three-state reading. */
  const roleWordOf = (destination: Destination): string => {
    if (destination.role === 'primary') return t('briefingPage.rolePrimary');
    if (destination.role === 'copy') return t('briefingPage.roleCopy');
    switch (destination.feedState) {
      case 'suspended':
        return t('briefingPage.roleFeedHeld');
      case 'no-carrier':
        return t('briefingPage.roleFeedNoCarrier');
      default:
        return t('briefingPage.roleFeed');
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={SPRING_GLIDE}
      transformTemplate={MAIN_THREAD_TRANSFORM}
      data-briefing-card={exeKey}
      className="flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3"
    >
      <div className="flex w-[168px] flex-none items-center gap-2">
        <Ring tone="main" size={14} live={sounding && liveness} />
        <ProcessIcon exeName={card.exeName} name={card.name} size={18} />
        <button
          type="button"
          onClick={() => {
            selectProcess(card.pid);
            onOpenBoard();
          }}
          title={t('briefingPage.openBoard', { name: card.name })}
          aria-label={t('briefingPage.openBoard', { name: card.name })}
          className="pressable min-w-0 flex-1 truncate text-left text-[12.5px] font-semibold text-text-primary outline-none hover:text-accent focus-visible:text-accent"
        >
          {card.name}
        </button>
      </div>
      <Connector />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        <AnimatePresence initial={false}>
          {card.destinations.map((destination) => (
            <Chip
              key={destination.key}
              destination={destination}
              roleWord={roleWordOf(destination)}
            />
          ))}
        </AnimatePresence>
      </div>
      {!sounding && (
        <span className="flex-none text-[10px] text-text-muted">{t('briefingPage.quiet')}</span>
      )}
    </motion.div>
  );
}
