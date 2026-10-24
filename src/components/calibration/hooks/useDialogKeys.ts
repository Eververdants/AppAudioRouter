import { useCallback, useEffect, type RefObject } from 'react';
import { FOCUSABLE_SELECTOR } from '@/components/calibration/constants';
import { isEditableTarget } from '@/lib/productionGuards';

/**
 * The two keys the dialog holds for as long as it is open.
 *
 * `aria-modal` alone does neither job: it tells assistive tech to ignore the
 * rest of the document and changes nothing about the real tab order, and the
 * Escape that closes a timed measurement has to reach the run before the next
 * burst does. Both are registered on the window in the capture phase, which is
 * what makes them arrive before the page underneath — and before the toast's
 * bubble-phase undo offer — and lets each of them stand down for a control that
 * owns the key itself.
 */
export function useDialogKeys({
  dialogRef,
  cancelRun,
  onClose,
}: {
  /** The dialog surface: the trap's container and the place a stray caret goes
   *  back to. */
  dialogRef: RefObject<HTMLDivElement | null>;
  /** The run's own stop, so closing the dialog never leaves a burst sounding. */
  cancelRun: () => void;
  onClose: () => void;
}) {
  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Escape belongs to the control holding the focus first — the wizard has
      // no field of its own, but focus can sit in one of the page's underneath
      // (a delay stepper's field, a control that owns the key via
      // `data-owns-escape`), and the capture phase below arrives before any of
      // them: standing down here is what leaves that press theirs.
      if (isEditableTarget(e.target)) return;
      e.stopPropagation();
      // Stop the walk *and* the sound: `cancelRun` is the only thing between a
      // burst and a dialog nobody can reach, and `onClose` unmounts this one —
      // whose cleanup names the run, so a `calibration_start` still on its way is
      // refused by the player instead of sounding into a dialog that is gone, and
      // the loop that awaited it reads the refusal where it is awaited.
      cancelRun();
      onClose();
    },
    [cancelRun, onClose],
  );

  // The tab trap. A dialog that declares `aria-modal` still has to hold the tab
  // order itself: the marker only tells assistive tech to ignore the rest of the
  // document, and `Tab` keeps walking through it. Registered while the dialog is
  // mounted and nowhere else, exactly like the Escape path beside it.
  const trapTab = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const container = dialogRef.current;
      if (container === null) return;
      const items = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (item) => item.getClientRects().length > 0,
      );
      const first = items[0];
      const last = items[items.length - 1];
      if (first === undefined || last === undefined) {
        // Nothing to walk: a screen with no control yet (the rows are still
        // arriving). Staying put is the honest answer, not letting the key out.
        event.preventDefault();
        container.focus();
        return;
      }
      const active = document.activeElement;
      const index = active instanceof HTMLElement ? items.indexOf(active) : -1;
      if (index === -1) {
        // The caret sits on the dialog surface itself, or has already slipped
        // behind it (an element under the pointer while it unmounted): pull it
        // back to the end or the start of the row it should have been on.
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      const atEdge = event.shiftKey ? index === 0 : index === items.length - 1;
      if (!atEdge) return;
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    },
    [dialogRef],
  );

  useEffect(() => {
    // The settings page stands down for Escape while this wizard is open (the
    // two sides change together); this listener is the only one that acts.
    // Capture phase, and the key is consumed: the toast's undo offer lives one
    // bubble-phase listener away, and a bubble-phase `stopPropagation` on the
    // same node cannot keep the key from it — only arriving first can.
    const onKey = (event: KeyboardEvent) => {
      trapTab(event);
      handleEscape(event);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [handleEscape, trapTab]);
}
