import { useEffect, useState } from 'react';

/**
 * Whether the board may move on its own.
 *
 * The live routes can be drawn as flowing rather than standing still, but the
 * flow is the interface's one persistent repaint, so it is allowed only while
 * somebody can actually see it and has not asked the system for less motion:
 *
 * - the window must be visible — a background window gets nothing, not even
 *   the composite;
 * - the window must hold focus — a window the user is looking *past* is
 *   background as far as the eye is concerned;
 * - the system must not have asked for reduced motion.
 *
 * When any of the three turns false the flow is not paused but unmounted: the
 * wire falls back to the steady line, and a resting interface produces no
 * repaints at all. That is the hard constraint the flow was bought against —
 * the wake-up cost of an idle engine is already accounted for in the audio
 * path, and the board must not add its own on top while nobody is watching.
 */
function mayAnimate(): boolean {
  if (document.visibilityState !== 'visible') return false;
  if (!document.hasFocus()) return false;
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useLiveness(): boolean {
  const [live, setLive] = useState(mayAnimate);

  useEffect(() => {
    const update = () => setLive(mayAnimate());
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    reduced.addEventListener('change', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      reduced.removeEventListener('change', update);
    };
  }, []);

  return live;
}
