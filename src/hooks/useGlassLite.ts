import { useCallback, useState } from 'react';
import { resolveGlassLite, setGlassLite as persistGlassLite } from '@/lib/glassLite';

/**
 * The settings-page switch for low-spec glass.
 *
 * `index.html`'s boot script has already applied the `glass-lite` class before
 * the first paint, the same way it applies the theme; this hook only takes over
 * from there, so its initial reading must match what the boot script resolved.
 */
export function useGlassLite() {
  const [glassLite, setGlassLiteState] = useState<boolean>(resolveGlassLite);

  const setGlassLite = useCallback((enabled: boolean) => {
    persistGlassLite(enabled);
    setGlassLiteState(enabled);
  }, []);

  return { glassLite, setGlassLite };
}
