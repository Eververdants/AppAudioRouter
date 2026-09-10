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
  modulePromise ??= import('@tauri-apps/api/window');
  return modulePromise;
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

/**
 * Reveals the main window.
 *
 * The window is created hidden (`"visible": false`) so the user never sees the
 * unstyled shell while the webview boots. The frontend calls this once it has
 * rendered; the two animation frames guarantee the first commit has actually
 * been painted, so the window appears fully formed. Rust keeps a watchdog that
 * shows the window anyway if this never runs.
 */
export async function revealMainWindow(): Promise<void> {
  const module = loadWindowModule();
  if (!module) return;
  try {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const { getCurrentWindow } = await module;
    const appWindow = getCurrentWindow();
    if (await appWindow.isVisible()) return;
    await appWindow.show();
    await appWindow.setFocus();
  } catch (error) {
    console.warn('[window] reveal failed', error);
  }
}
