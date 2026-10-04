/**
 * Low-spec glass: the same material with the expensive half switched off.
 *
 * The cost of a lens is its refraction — `backdrop-filter` re-samples
 * everything behind a pane on every frame anything above it moves — and that is
 * the single most expensive thing this UI does per pixel. The `glass-lite`
 * class on `<html>` swaps the glass tokens for a near-opaque fill set (both
 * themes, in `styles/index.css`), so panes keep their rim, specular and shadow
 * but stop refracting, and the pointer-tracked highlight stops tracking
 * (`useGlassSpecular` reads `isGlassLite()` per event).
 *
 * The choice belongs to the user, persisted as `aar-glass-lite` in localStorage
 * and written by the settings switch. Before they make one, the machine
 * decides: weak hardware, or Windows' own transparency effects turned off
 * (which reaches the webview as `prefers-reduced-transparency`), starts in
 * low-spec. `index.html`'s boot script applies the class before the first
 * paint and mirrors this file's logic — keep the two in sync.
 */

export const GLASS_LITE_STORAGE_KEY = 'aar-glass-lite';

/** The class this module owns on `<html>`. */
export const GLASS_LITE_CLASS = 'glass-lite';

/** Reads the user's explicit choice, or null while they have not made one. */
export function readStoredGlassLite(): boolean | null {
  try {
    const stored = localStorage.getItem(GLASS_LITE_STORAGE_KEY);
    if (stored === '1') return true;
    if (stored === '0') return false;
  } catch {
    /* storage may be unavailable; fall through to the machine's verdict */
  }
  return null;
}

/**
 * Hardware that pays real frame time for blur: few cores or little memory.
 * `deviceMemory` is Chromium-only, hence the widening — WebView2 has it, a
 * plain browser may not.
 */
export function isLowSpecHardware(): boolean {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = navigator.hardwareConcurrency ?? 8;
  const memory = nav.deviceMemory ?? 8;
  return cores <= 4 || memory <= 4;
}

/**
 * Windows 11's "transparency effects" switch surfaces in Chromium as this
 * media query — the same preference the OS's own acrylic obeys.
 */
export function prefersNoTransparency(): boolean {
  return window.matchMedia('(prefers-reduced-transparency: reduce)').matches;
}

/** The effective value: the user's choice first, then the machine's verdict. */
export function resolveGlassLite(): boolean {
  return readStoredGlassLite() ?? (prefersNoTransparency() || isLowSpecHardware());
}

export function isGlassLite(): boolean {
  return document.documentElement.classList.contains(GLASS_LITE_CLASS);
}

/** Applies the value to the document without persisting it. */
export function applyGlassLite(enabled: boolean): void {
  document.documentElement.classList.toggle(GLASS_LITE_CLASS, enabled);
}

/** Persists the user's choice and applies it — what the settings switch does. */
export function setGlassLite(enabled: boolean): void {
  try {
    localStorage.setItem(GLASS_LITE_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    /* storage may be unavailable; the preference just does not persist */
  }
  applyGlassLite(enabled);
}
