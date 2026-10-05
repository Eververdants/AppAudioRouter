import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { FADE, SPRING_GLIDE } from '@/lib/motion';
import { isEditableTarget } from '@/lib/productionGuards';
import { useRouterStore } from '@/stores/routerStore';

/** How long the offer stands before it takes itself away. */
const TOAST_DISMISS_MS = 8000;

/**
 * The offer to undo the route that was just applied.
 *
 * Routing is one click, and it is a click that takes over programs the user may
 * not have meant to move — several at once when they were multi-selected, and
 * onto every selected device. This is the way back, on screen for as long as the
 * mistake is still fresh.
 *
 * It is transient by design and never modal: it reports what happened, offers
 * the one action that can still change it, and gets out of the way. Nothing is
 * stolen from the user to show it — no focus, no layout, no dialog to dismiss
 * before the next thing they wanted to do.
 */
export function Toast() {
  const { t } = useTranslation();
  const snapshot = useRouterStore((s) => s.undoSnapshot);
  const undoLastRoute = useRouterStore((s) => s.undoLastRoute);
  const dismissUndo = useRouterStore((s) => s.dismissUndo);
  const feedUndo = useRouterStore((s) => s.feedUndo);
  const undoFeed = useRouterStore((s) => s.undoFeed);
  const dismissFeedUndo = useRouterStore((s) => s.dismissFeedUndo);
  // Held while the pointer or the keyboard is on the offer, so a user reaching
  // for the button does not have it taken away mid-reach.
  const [held, setHeld] = useState(false);

  // Keyed on the snapshot itself, not on it being non-null: a route applied
  // while the offer is still standing replaces it, and the countdown starts over
  // rather than expiring under a question that has just changed. The feed offer
  // runs its own timer on the same rule.
  useEffect(() => {
    if (snapshot === null || held) return;
    const timer = window.setTimeout(() => dismissUndo(), TOAST_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [snapshot, held, dismissUndo]);

  useEffect(() => {
    if (feedUndo === null || held) return;
    const timer = window.setTimeout(() => dismissFeedUndo(), TOAST_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [feedUndo, held, dismissFeedUndo]);

  useEffect(() => {
    // A card that is gone cannot report the pointer leaving it: an offer that
    // ended while the pointer was on it — the button was clicked, Escape was
    // pressed — must not leave the next one held forever.
    if (snapshot === null && feedUndo === null) setHeld(false);
  }, [snapshot, feedUndo]);

  useEffect(() => {
    if (snapshot === null && feedUndo === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Escape belongs to the field that has the focus first. Clearing the
      // app list's search box is the same key, and the search box does not
      // stop the event — so without this, dismissing a search silently spent
      // the one offer that could still undo the route.
      if (isEditableTarget(event.target)) return;
      dismissUndo();
      dismissFeedUndo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [snapshot, feedUndo, dismissUndo, dismissFeedUndo]);

  const entries = snapshot?.entries ?? [];
  const only = entries[0];
  const sessions = useRouterStore((s) => s.sessions);
  const feedSource = feedUndo !== null
    ? sessions.find((s) => s.pid === feedUndo.sourcePid)?.display_name ??
      sessions.find((s) => s.pid === feedUndo.sourcePid)?.exe_name
    : undefined;
  const feedTarget = feedUndo !== null
    ? sessions.find((s) => s.pid === feedUndo.targetPid)?.display_name ??
      sessions.find((s) => s.pid === feedUndo.targetPid)?.exe_name
    : undefined;

  return (
    // The layer spans the bottom of the window but takes no pointer events: only
    // the cards themselves are clickable, so whatever is behind it stays usable.
    // Two offers can stand at once (a route and a feed); they stack.
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex flex-col items-center justify-center gap-2 p-4">
      <AnimatePresence>
        {feedUndo !== null && feedSource !== undefined && feedTarget !== undefined && (
          <motion.div
            key={`feed-toast-${feedUndo.added ? 'add' : 'remove'}-${feedUndo.sourcePid}-${feedUndo.targetPid}`}
            role="status"
            aria-live="polite"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0, pointerEvents: 'auto' }}
            exit={{ opacity: 0, y: 8, pointerEvents: 'none' }}
            transition={{ opacity: FADE, y: SPRING_GLIDE }}
            onPointerEnter={() => setHeld(true)}
            onPointerLeave={() => setHeld(false)}
            onFocus={() => setHeld(true)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setHeld(false);
              }
            }}
            className="bg-surface border-line shadow-float pointer-events-auto flex items-center gap-3 rounded-full border py-2 pl-4 pr-2"
          >
            <span className="text-[12px] text-text-secondary">
              {feedUndo.added
                ? t('toast.feedAdded', { source: feedSource, target: feedTarget })
                : t('toast.feedRemoved', { source: feedSource, target: feedTarget })}
            </span>
            <button
              type="button"
              onClick={() => void undoFeed()}
              className="shrink-0 rounded px-2.5 py-1 text-[12px] font-semibold text-accent outline-none transition-colors hover:bg-accent-muted focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              {t('toast.undo')}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {snapshot !== null && (
          <motion.div
            key="undo-toast"
            role="status"
            aria-live="polite"
            initial={{ opacity: 0, y: 16 }}
            // `pointerEvents` is named on the way in as well as on the way out,
            // and it is not decoration: the exit sets it to `none` inline, and
            // framer keeps an inline value it has no target for. Without this, a
            // new offer arriving during the previous one's exit (~0.2 s) would
            // re-mount a card whose Undo button is dead.
            animate={{ opacity: 1, y: 0, pointerEvents: 'auto' }}
            // `pointerEvents` is not animatable, so it is applied as the exit
            // begins rather than animated: without it the card goes on taking
            // clicks for as long as it is fading out, and the click that follows
            // a dismissal lands on a card that is already gone from the user's
            // point of view.
            exit={{ opacity: 0, y: 8, pointerEvents: 'none' }}
            transition={{ opacity: FADE, y: SPRING_GLIDE }}
            onPointerEnter={() => setHeld(true)}
            onPointerLeave={() => setHeld(false)}
            onFocus={() => setHeld(true)}
            onBlur={(event) => {
              // Moving between the card's own controls is not a reason to start
              // counting down again; leaving it is.
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setHeld(false);
              }
            }}
            className="bg-surface border border-line shadow-float pointer-events-auto flex items-center gap-3 rounded-full py-2 pl-4 pr-2"
          >
            <span className="text-[12px] text-text-secondary">
              {/* The offer names where the sound went, not just that it moved:
                  "routed music.exe" answers nothing for someone who did not
                  mean to route anything. */}
              {entries.length > 1
                ? snapshot.deviceCount > 1
                  ? t('toast.routedManyMore', {
                      n: entries.length,
                      device: snapshot.deviceName,
                      m: snapshot.deviceCount - 1,
                    })
                  : t('toast.routedMany', { n: entries.length, device: snapshot.deviceName })
                : snapshot.deviceCount > 1
                  ? t('toast.routedOneMore', {
                      process: only?.exeName ?? '',
                      device: snapshot.deviceName,
                      m: snapshot.deviceCount - 1,
                    })
                  : t('toast.routedOne', {
                      process: only?.exeName ?? '',
                      device: snapshot.deviceName,
                    })}
            </span>
            <button
              type="button"
              onClick={() => void undoLastRoute()}
              className="shrink-0 rounded px-2.5 py-1 text-[12px] font-semibold text-accent outline-none transition-colors hover:bg-accent-muted focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              {t('toast.undo')}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
