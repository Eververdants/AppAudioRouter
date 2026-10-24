import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { SourceLevelDial } from '@/components/SourceLevelDial';
import { ProcessIcon } from '@/components/ui/ProcessIcon';
import { Ring } from '@/components/ui/Ring';
import { Spinner } from '@/components/ui/Spinner';
import { MAIN_THREAD_TRANSFORM, SPRING_GLIDE, SPRING_ROUTE, SPRING_TAP } from '@/lib/motion';
import { HUB_H, HUB_W, HUB_X } from '@/lib/stage';
import type { AudioSession } from '@/lib/types';
import { CharSwapText } from './CharSwapText';
import { CARD_CLASS } from './shared';
import type { PlannedFeed } from './hooks/useFeedPlan';
import type { IconSwap, NameSwap } from './hooks/useHubIdentity';
import type { RefObject } from 'react';

/**
 * The hub card: the programme under the cursor, the apply capsule it wears
 * while the plan is not yet the truth, the one beat it plays when the plan
 * lands, and the level dial that rides under it for multi-device routes.
 *
 * Both the card and the dial are siblings of everything else on the board — the
 * dial is not inside the card, and the fragment keeps it that way.
 */
export function HubCard({
  session,
  name,
  hubName,
  hubY,
  hubRef,
  canApply,
  applying,
  sounding,
  hasPlan,
  drawn,
  planFeedStates,
  feeders,
  landPulse,
  hubAria,
  liveness,
  setHoverKey,
  applyRoute,
  nameSwap,
  iconSwap,
}: {
  session: AudioSession | undefined;
  name: string | undefined;
  hubName: string;
  hubY: number;
  /** The card itself: the level dial hands focus back here when it unmounts. */
  hubRef: RefObject<HTMLButtonElement | null>;
  canApply: boolean;
  applying: boolean;
  sounding: boolean;
  hasPlan: boolean;
  drawn: string[];
  planFeedStates: PlannedFeed[];
  feeders: AudioSession[];
  landPulse: number;
  hubAria: string;
  liveness: boolean;
  setHoverKey: (key: string | null) => void;
  applyRoute: () => Promise<void>;
  /** The hub's name and tile swaps, held by the board rather than the card:
   *  the card remounts on a programme switch and the swap must survive it. */
  nameSwap: NameSwap;
  iconSwap: IconSwap;
}) {
  const { t } = useTranslation();
  return (
    <>
      {/* The hub: the programme under the cursor. A proposal waiting for
              the press wears the apply capsule; already-applied, it is a card
              like the others and clicking it opens the strip below. */}
      {session === undefined ? (
        <motion.div
          className={`${CARD_CLASS} flex items-center justify-center px-4 text-center`}
          style={{ left: HUB_X, top: hubY, width: HUB_W, height: HUB_H }}
        >
          <span className="text-[12px] leading-relaxed text-text-muted">{t('stage.guide')}</span>
        </motion.div>
      ) : (
        <motion.button
          key={session.pid}
          ref={hubRef}
          type="button"
          data-source-node="subject"
          // The card is a button only while it lands something: once what is
          // drawn is what is playing, it goes back to being a label — a
          // board never asks anyone to confirm what they can hear. The
          // programme's own summary lives in the strip below either way.
          //
          // `aria-disabled` rather than `disabled`, because Chromium
          // dispatches no mouse events on a disabled control and this card
          // is where the hover that lights its wires begins — which is to
          // say the hovering never happened exactly when the wires were
          // flowing. The press is guarded below, and `cursor-default` says
          // what the answer already is.
          aria-disabled={!canApply}
          onMouseEnter={() => setHoverKey('hub')}
          onMouseLeave={() => setHoverKey(null)}
          onClick={() => {
            if (canApply) void applyRoute();
          }}
          aria-label={hubAria}
          whileTap={canApply ? { scale: 0.98 } : undefined}
          transformTemplate={MAIN_THREAD_TRANSFORM}
          transition={SPRING_TAP}
          className={`${CARD_CLASS} ${
            canApply
              ? 'cursor-pointer border-accent/60 hover:border-accent focus-visible:border-accent'
              : 'cursor-default'
          } flex flex-col items-center justify-center gap-1 px-4 text-center focus-visible:outline-none`}
          style={{ left: HUB_X, top: hubY, width: HUB_W, height: HUB_H }}
        >
          {/* The apply capsule pops in when the plan departs from the truth
                  and shrinks back the moment it lands — both ends animated,
                  because an instant swap makes the landing itself unread.
                  Motion owns the whole transform: a Tailwind
                  `-translate-x-1/2` centering would be overridden by the inline
                  transform, so the centering rides inside the animated values
                  as a constant `x`. With more than one destination it counts
                  them: "also play here" is the one press on this board that
                  makes sound come out of a second place, and the count is said
                  before it happens rather than noticed after. */}
          <AnimatePresence initial={false}>
            {canApply && (
              <motion.span
                key="apply-hint"
                initial={{ opacity: 0, x: '-50%', y: -4, scale: 0.9 }}
                animate={{ opacity: 1, x: '-50%', y: 0, scale: 1 }}
                exit={{ opacity: 0, x: '-50%', y: -3, scale: 0.96 }}
                transition={SPRING_TAP}
                transformTemplate={MAIN_THREAD_TRANSFORM}
                className="absolute -top-3 left-1/2 whitespace-nowrap rounded-full bg-accent px-2.5 py-0.5 text-xs font-semibold text-accent-ink"
              >
                {drawn.length > 1
                  ? t('stage.applyHintMany', { n: drawn.length })
                  : t('stage.applyHint')}
              </motion.span>
            )}
          </AnimatePresence>
          {/* One beat when a proposal becomes the truth: a single accent
                  hairline expands off the card and dies. While the programme is
                  silent this is the landing's only feedback — a flowing wire and
                  a pulsing ring both need sound to report — and it plays once,
                  never standing. */}
          {landPulse > 0 && (
            <motion.span
              key={landPulse}
              aria-hidden="true"
              initial={{ opacity: 0.55, scale: 0.94 }}
              animate={{ opacity: 0, scale: 1.06 }}
              transition={SPRING_ROUTE}
              transformTemplate={MAIN_THREAD_TRANSFORM}
              className="pointer-events-none absolute inset-0 rounded-panel border border-accent"
            />
          )}
          {/* Balanced around the name: icon prefix + name slot + trailing
                  ring total exactly the card's inner width (18 + 8 + 106 + 10
                  + 16 = 158), so the slot's centre — and with it every name
                  that swaps inside — sits on the card's centreline, the same
                  axis as the status line below and the apply capsule above. */}
          <span className="flex items-center gap-2">
            <ProcessIcon
              exeName={session.exe_name}
              name={name ?? session.exe_name}
              size={18}
              prev={iconSwap.prev}
              swapKey={iconSwap.key}
            />
            <CharSwapText text={hubName} prev={nameSwap.prev} swapKey={nameSwap.key} />
            <Ring
              tone={hasPlan ? 'main' : 'idle'}
              size={16}
              live={sounding && liveness}
              className="ml-0.5"
            />
          </span>
          <span className="text-xs text-text-muted">
            {applying && (
              <Spinner size={10} className="mr-1 inline-block align-[-1px] text-accent" />
            )}
            {sounding ? t('stage.sounding') : t('stage.quiet')}
            {planFeedStates.length > 0 && (
              <span className="text-type-feed">
                {' '}
                · {t('stage.feedCount', { n: planFeedStates.length })}
              </span>
            )}
          </span>
          {/* The in-pin exists only when someone is feeding this programme;
                  an unused pin is not drawn, so the hub does not grow sockets
                  that mean nothing. */}
          {feeders.length > 0 && <span className="pin pin-in" aria-hidden="true" />}
          <span className="pin pin-out" aria-hidden="true" />
        </motion.button>
      )}

      {/* The level dial rides under the hub, exactly where the ring stage
              kept it: multi-device routes only, program-scoped. It rises the
              few pixels it sits below the hub on the way in — an arrival, not
              a pop. */}
      {session !== undefined && drawn.length > 1 && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={SPRING_GLIDE}
          transformTemplate={MAIN_THREAD_TRANSFORM}
          className="absolute flex justify-center"
          style={{ left: HUB_X - 40, top: hubY + HUB_H + 12, width: HUB_W + 80 }}
        >
          <SourceLevelDial
            exeName={session.exe_name}
            displayName={session.display_name ?? undefined}
            hostRef={hubRef}
          />
        </motion.div>
      )}
    </>
  );
}
