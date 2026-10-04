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
 */
export function useGlassSpecular(): void {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let current: HTMLElement | null = null;

    const clear = (pane: HTMLElement) => {
      pane.style.removeProperty('--gx');
      pane.style.removeProperty('--gy');
    };

    const onMove = (event: PointerEvent) => {
      // Read per event rather than at mount, so flipping the setting in the
      // settings page takes effect without remounting the app.
      if (isGlassLite()) {
        if (current) clear(current);
        current = null;
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      const pane = target.closest<HTMLElement>(PANE_SELECTOR);
      if (pane !== current) {
        if (current) clear(current);
        current = pane;
      }
      if (!pane) return;
      const rect = pane.getBoundingClientRect();
      pane.style.setProperty('--gx', `${event.clientX - rect.left}px`);
      pane.style.setProperty('--gy', `${event.clientY - rect.top}px`);
    };

    const onLeave = () => {
      if (current) clear(current);
      current = null;
    };

    document.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      if (current) clear(current);
    };
  }, []);
}
