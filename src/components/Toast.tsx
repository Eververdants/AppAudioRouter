import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { FADE, SPRING_GLIDE } from '@/lib/motion';
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
  // Held while the pointer or the keyboard is on the offer, so a user reaching
  // for the button does not have it taken away mid-reach.
  const [held, setHeld] = useState(false);

  // Keyed on the snapshot itself, not on it being non-null: a route applied
  // while the offer is still standing replaces it, and the countdown starts over
  // rather than expiring under a question that has just changed.
  useEffect(() => {
    if (snapshot === null || held) return;
    const timer = window.setTimeout(() => dismissUndo(), TOAST_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [snapshot, held, dismissUndo]);

  useEffect(() => {
    // A card that is gone cannot report the pointer leaving it: an offer that
    // ended while the pointer was on it — the button was clicked, Escape was
    // pressed — must not leave the next one held forever.
    if (snapshot === null) setHeld(false);
  }, [snapshot]);

  useEffect(() => {
    if (snapshot === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismissUndo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [snapshot, dismissUndo]);

  const entries = snapshot?.entries ?? [];
  const only = entries[0];

  return (
    // The layer spans the bottom of the window but takes no pointer events: only
    // the card itself is clickable, so whatever is behind it stays usable.
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center p-4">
      <AnimatePresence>
        {snapshot !== null && (
          <motion.div
            key="undo-toast"
            role="status"
            aria-live="polite"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
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
            className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-glass bg-glass-strong px-4 py-2.5 shadow-glass backdrop-blur-xl"
          >
            <span className="text-[12px] text-text-secondary">
              {entries.length > 1
                ? t('toast.messageMulti', { n: entries.length })
                : t('toast.message', { process: only?.exeName ?? '' })}
            </span>
            <button
              type="button"
              onClick={() => void undoLastRoute()}
              className="shrink-0 rounded-full bg-accent px-3 py-1 text-[11px] font-medium text-white outline-none transition-colors hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              {t('toast.undo')}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
