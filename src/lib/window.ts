/**
 * Window helpers for the custom (frameless) title bar.
 *
 * Everything here goes through a **lazy** `import('@tauri-apps/api/window')`:
 * the entry chunk is what the webview has to parse before its first paint, and
 * none of the window API is needed for that first frame. Loading it on demand
 * removes it from the startup payload.
 *
 * Every call is also failure-tolerant. The app can be opened in a plain browser
 * during `vite dev`, and a missing ACL permission must never break the UI.
 */

type WindowModule = typeof import('@tauri-apps/api/window');

let modulePromise: Promise<WindowModule> | null = null;

/** True when running inside the Tauri shell, false in a plain browser tab. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function loadWindowModule(): Promise<WindowModule> | null {
  if (!isTauri()) return null;
  if (modulePromise !== null) return modulePromise;

  const loading = import('@tauri-apps/api/window');
  // Reset on failure so a transient error doesn't cache the rejection forever:
  // without this, one failed import leaves the window buttons dead for the rest
  // of the session. The reset is attached once, here at the assignment, rather
  // than on every call — a handler per call would pile onto a promise that
  // outlives all of them. And it only clears a promise that is still the one
  // that failed, so a later reload already in flight is never thrown away.
  const forget = (): void => {
    if (modulePromise === loading) modulePromise = null;
  };
  loading.catch(forget);
  modulePromise = loading;
  return loading;
}

/** Runs `action` against the current window, swallowing any failure. */
async function withWindow(
  action: (api: WindowModule) => Promise<unknown>,
  description: string,
): Promise<void> {
  const module = loadWindowModule();
  if (!module) return;
  try {
    await action(await module);
  } catch (error) {
    console.warn(`[window] ${description} failed`, error);
  }
}

/** Minimizes the main window. */
export const minimizeWindow = (): Promise<void> =>
  withWindow(({ getCurrentWindow }) => getCurrentWindow().minimize(), 'minimize');

/** Toggles the main window between maximized and restored. */
export const toggleMaximizeWindow = (): Promise<void> =>
  withWindow(({ getCurrentWindow }) => getCurrentWindow().toggleMaximize(), 'toggleMaximize');

/** Closes the main window. */
export const closeWindow = (): Promise<void> =>
  withWindow(({ getCurrentWindow }) => getCurrentWindow().close(), 'close');

/** Whether the main window is currently maximized. Always false outside Tauri. */
export async function isWindowMaximized(): Promise<boolean> {
  const module = loadWindowModule();
  if (!module) return false;
  try {
    const { getCurrentWindow } = await module;
    return await getCurrentWindow().isMaximized();
  } catch (error) {
    console.warn('[window] isMaximized failed', error);
    return false;
  }
}

/**
 * Subscribes to resize / maximize events on the main window.
 *
 * Resolves to an unsubscribe function, or to a no-op outside Tauri. The result
 * is always safe to call once the caller is done with it, even if it is torn
 * down before the subscription resolved.
 */
export async function onWindowResized(handler: () => void): Promise<() => void> {
  const module = loadWindowModule();
  if (!module) return () => {};
  try {
    const { getCurrentWindow } = await module;
    return await getCurrentWindow().onResized(handler);
  } catch (error) {
    console.warn('[window] onResized failed', error);
    return () => {};
  }
}

/** How long to wait for the first painted frame before revealing anyway.
 *
 * Two animation frames is the guarantee that the first commit actually reached
 * the screen; it is not a guarantee that frames are being produced at all. A
 * window created with `visible: false` has no reason to paint, and a renderer
 * that is not painting does not schedule frames — an unbounded wait then hangs
 * the reveal forever, and the only thing left is Rust's watchdog, which shows
 * the window five seconds late and without the focus this call also owes. So
 * the frame is worth waiting for *up to a moment*, and the reveal is worth more.
 */
export const PAINT_WAIT_MS = 250;

/** Resolve after the next two frames, or after `PAINT_WAIT_MS`, whichever comes
 * first. A host that cannot even schedule a frame is answered immediately. */
function waitForFirstPaint(): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, PAINT_WAIT_MS);
    try {
      requestAnimationFrame(() => requestAnimationFrame(finish));
    } catch {
      finish();
    }
  });
}

/**
 * Reveals the main window.
 *
 * The window is created hidden (`"visible": false`) so the user never sees the
 * unstyled shell while the webview boots. The frontend calls this once it has
 * rendered; the two animation frames guarantee the first commit has actually
 * been painted, so the window appears fully formed — bounded by
 * [`PAINT_WAIT_MS`](250), because a window that has never been shown may never
 * produce a frame and the reveal must not hang on it. Rust keeps a watchdog that
 * shows the window anyway if this never runs (`spawn_reveal_watchdog`, five
 * seconds, and stood down for a `--hidden` logon launch); it is the reason a
 * stalled reveal is a late window rather than no window, and it is not a reason
 * to wait for one.
 */
export async function revealMainWindow(): Promise<void> {
  const module = loadWindowModule();
  if (!module) return;
  try {
    await waitForFirstPaint();
    const { getCurrentWindow } = await module;
    const appWindow = getCurrentWindow();
    if (await appWindow.isVisible()) return;
    await appWindow.show();
    await appWindow.setFocus();
  } catch (error) {
    console.warn('[window] reveal failed', error);
  }
}
