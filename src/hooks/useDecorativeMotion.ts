import { useEffect, useState } from 'react';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function isWatched(): boolean {
  return (
    !document.hidden && document.hasFocus() && !window.matchMedia(REDUCED_MOTION_QUERY).matches
  );
}

/**
 * Whether the decorative, endlessly-looping animation should be running.
 *
 * The stage is lit by blurred blobs drifting behind frosted glass, dashed route
 * lines flowing out of the hub, and pulse rings on the devices a route is live
 * on. Every one of those loops forever, and repainting a backdrop blur is work
 * the compositor repeats whether or not anybody is looking — which is how a
 * routing tool left open in the background ends up spinning a laptop's fan while
 * Task Manager shows the app itself as idle. The cost lands in WebView2's GPU
 * process, a separate entry nobody attributes to this program.
 *
 * So the loops only run while the window is genuinely in front of the user, and
 * never when the system asks for reduced motion. Both reveal paths (`show` +
 * `setFocus`) hand the window the keyboard, so a launched or tray-restored
 * window starts awake. Animation that communicates state — selection, the route
 * ripple, entrance transitions — is not decorative and is deliberately left
 * alone; this gates only motion that exists to be pretty.
 */
export function useDecorativeMotion(): boolean {
  const [watched, setWatched] = useState(isWatched);

  useEffect(() => {
    const update = () => setWatched(isWatched());
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    // Focus and visibility can both have moved between render and effect.
    update();
    document.addEventListener('visibilitychange', update);
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    query.addEventListener('change', update);
    return () => {
      document.removeEventListener('visibilitychange', update);
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      query.removeEventListener('change', update);
    };
  }, []);

  return watched;
}
