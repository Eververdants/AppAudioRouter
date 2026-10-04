import { useEffect } from 'react';
import { isGlassLite } from '@/lib/glassLite';

/** Selectors whose specular highlight follows the pointer. */
const PANE_SELECTOR = '.glass, .glass-strong';

/**
 * Makes a glass pane's specular highlight track the pointer, the way a real lens
 * catches a moving light source: one delegated `pointermove` writes the hovered
 * pane's local pointer position into `--gx/--gy`, and the pane's own
 * `--glass-specular` radial is placed at those coordinates.
 *
 * One listener for the whole window rather than a handler per pane, because the
 * behaviour is a property of the material, not of any one component. The write
 * is two CSS custom properties on a single element, so tracking costs a style
 * recalculation of one pane and nothing else — and it stops the instant the
 * pointer leaves, leaving the highlight resting at the top like light from
 * above. Under `prefers-reduced-motion` the listener is never attached: a
 * highlight that slides is motion, and the system asked for less of it. Low-spec
 * glass parks the highlight too — a recalculation per pointer move is exactly
 * what that mode exists to skip.
 *
 * Several moves land inside one frame, and only the last of them is worth
 * drawing. Which pane the pointer is over is resolved as the events arrive,
 * because that costs no layout; the pane's box is measured once per frame, in
 * the frame that will show it. Measuring per event instead would force a layout
 * the browser had no other reason to perform, on the one input the window
 * receives more often than any other.
 */
export function useGlassSpecular(): void {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let current: HTMLElement | null = null;
    /** Where the pointer was, as of the last move of this frame. */
    let pending: { x: number; y: number } | null = null;
    let frame: number | null = null;

    const clear = (pane: HTMLElement) => {
      pane.style.removeProperty('--gx');
      pane.style.removeProperty('--gy');
    };

    /** Drop the tracked pane and anything waiting to be drawn on it. */
    const stop = () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
        frame = null;
      }
      pending = null;
      if (current !== null) clear(current);
      current = null;
    };

    const flush = () => {
      frame = null;
      const pane = current;
      const at = pending;
      pending = null;
      if (pane === null || at === null) return;
      const rect = pane.getBoundingClientRect();
      pane.style.setProperty('--gx', `${at.x - rect.left}px`);
      pane.style.setProperty('--gy', `${at.y - rect.top}px`);
    };

    const onMove = (event: PointerEvent) => {
      // Read per event rather than at mount, so flipping the setting in the
      // settings page takes effect without remounting the app.
      if (isGlassLite()) {
        stop();
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      const pane = target.closest<HTMLElement>(PANE_SELECTOR);
      if (pane !== current) {
        if (current !== null) clear(current);
        current = pane;
      }
      if (pane === null) return;
      pending = { x: event.clientX, y: event.clientY };
      frame ??= window.requestAnimationFrame(flush);
    };

    const onLeave = () => stop();

    document.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      stop();
    };
  }, []);
}
