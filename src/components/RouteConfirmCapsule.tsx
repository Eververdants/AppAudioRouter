import { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { FADE, SPRING_GLIDE } from '@/lib/motion';
import { useRouterStore } from '@/stores/routerStore';

/**
 * Whether what is staged is exactly what is already playing.
 *
 * The question the capsule asks ("route this there") has already been answered
 * when the staged targets are the ones the selection is routed to — the state
 * the store lands in right after a route, and the state a freshly selected
 * program with a remembered route starts in. Asking again there would be asking
 * the user to confirm what they are looking at.
 */
function alreadyApplied(staged: string[], pids: number[], routedPids: Record<number, string[] | undefined>): boolean {
  if (staged.length === 0 || pids.length === 0) return false;
  return pids.every((pid) => {
    const ids = routedPids[pid];
    return ids !== undefined && ids.length === staged.length && ids.every((id, i) => id === staged[i]);
  });
}

/**
 * The route question, floating over the bottom of the work area.
 *
 * Routing takes over the sound of programs — several at once when they were
 * multi-selected, and onto every staged device — so it is the one action here
 * that is not allowed to be a stray click. The question therefore sits apart
 * from the list it is about: a raised capsule that names the program and the
 * device in words, with both answers next to each other, instead of a button
 * that turns into a different button when pressed.
 *
 * It is not modal and not in the layout: nothing is displaced while it is up,
 * the rows behind it stay usable, and it takes itself away as soon as what is
 * staged matches what is playing.
 */
export function RouteConfirmCapsule() {
  const { t } = useTranslation();
  const devices = useRouterStore((s) => s.devices);
  const sessions = useRouterStore((s) => s.sessions);
  const selectedPids = useRouterStore((s) => s.selectedPids);
  const selectedDeviceIds = useRouterStore((s) => s.selectedDeviceIds);
  const routedPids = useRouterStore((s) => s.routedPids);
  const applying = useRouterStore((s) => s.applying);
  const applyRoute = useRouterStore((s) => s.applyRoute);

  const staged = selectedDeviceIds;
  const primarySession =
    selectedPids.length > 0 ? sessions.find((s) => s.pid === selectedPids[0]) : undefined;
  const primaryDevice = devices.find((d) => d.id === staged[0]);

  /**
   * The question, when there is one to ask: a program and a device to name in
   * it. Both halves are needed — a staged device with no program, or a program
   * with nowhere to go, is not a question — and so is an answer that has not
   * already been given.
   */
  const question =
    !alreadyApplied(staged, selectedPids, routedPids) &&
    primarySession !== undefined &&
    primaryDevice !== undefined
      ? { session: primarySession, device: primaryDevice, extra: staged.length - 1 }
      : null;
  const asking = question !== null;

  // Cancelling un-stages the targets. The store's toggle owns the list, so it is
  // asked one id at a time, reading the list at the moment of each call rather
  // than from a render-time snapshot that the previous call has invalidated.
  const cancel = () => {
    const store = useRouterStore.getState();
    for (const id of [...store.selectedDeviceIds]) store.toggleDeviceSelection(id);
  };

  useEffect(() => {
    // Only while the capsule is up. The listener is in the capture phase so it
    // can stop Escape before whatever is behind the capsule answers it — which
    // is exactly why it must not be registered when there is nothing to
    // dismiss: a standing capture-phase listener swallows Escape for the whole
    // window, and the search box stops clearing on the key every other search
    // box clears on.
    if (!asking) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Only the staged route is dropped; Escape must not also close whatever
        // the user was doing behind the capsule.
        event.stopPropagation();
        cancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [asking]);

  return (
    // The layer is a full-width strip that takes no pointer events, so only the
    // capsule itself is clickable and the table behind it stays usable.
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center px-4">
      <AnimatePresence>
        {question !== null && (
          <motion.div
            key="route-confirm"
            role="group"
            aria-label={t('router.currentRoute')}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0, pointerEvents: 'auto' }}
            exit={{ opacity: 0, y: 8, pointerEvents: 'none' }}
            transition={{ opacity: FADE, y: SPRING_GLIDE }}
            className="pointer-events-auto flex max-w-full items-center gap-3 rounded-full border border-line-strong bg-surface-raised py-2 pl-3.5 pr-2.5 shadow-[0_12px_28px_-12px_rgba(0,0,0,0.55)]"
          >
            <span aria-hidden="true" className="h-1.5 w-1.5 flex-none rounded-full bg-accent" />
            <span className="flex min-w-0 items-center gap-2 text-[12px]">
              <span className="truncate text-text-secondary">
                {selectedPids.length > 1
                  ? t('router.processCount', { n: selectedPids.length })
                  : question.session.exe_name}
              </span>
              <span aria-hidden="true" className="flex-none text-text-muted">
                →
              </span>
              <span className="truncate font-medium text-text-primary">{question.device.name}</span>
              {question.extra > 0 && (
                <span className="flex-none font-mono text-[11px] tabular-nums text-text-muted">
                  +{question.extra}
                </span>
              )}
            </span>
            <span aria-hidden="true" className="h-4 w-px flex-none bg-line" />
            <button
              type="button"
              onClick={cancel}
              title={t('router.cancelHint')}
              className="flex-none rounded px-2 py-1 text-[12px] text-text-muted outline-none transition-colors hover:bg-surface-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              {t('router.cancel')}
            </button>
            <button
              type="button"
              onClick={() => void applyRoute()}
              disabled={applying}
              className="flex-none rounded px-2.5 py-1 text-[12px] font-semibold text-accent outline-none transition-colors hover:bg-accent-muted focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-progress disabled:opacity-60"
            >
              {t('router.confirmAction')}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
