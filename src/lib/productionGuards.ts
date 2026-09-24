/**
 * Release-only webview restrictions.
 *
 * Development keeps the full browser surface (Vite HMR, reload shortcuts and
 * DevTools). Production should behave like a desktop app: no native browser
 * context menu, no HTML drag/drop, and no inspector shortcuts. Tauri already
 * disables WebView2 DevTools for release builds; these DOM guards cover
 * shortcuts that the webview can still interpret before Tauri sees them.
 */

const EDITING_KEYS = new Set(['a', 'c', 'v', 'x', 'y', 'z']);

/** Returns true when `target` is an editable control. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  );
}

/**
 * Standard editing shortcuts must keep working while an input is focused.
 * None of these are in the inspector block list today, but keeping the
 * exemption explicit prevents a future browser-shortcut guard from eating
 * copy/paste/select-all/undo in editable controls.
 */
function isEditingShortcut(event: KeyboardEvent): boolean {
  if (!isEditableTarget(event.target)) return false;

  const key = event.key.toLowerCase();
  const commandKey = event.ctrlKey || event.metaKey;

  return (
    (commandKey && EDITING_KEYS.has(key)) ||
    (event.shiftKey && key === 'insert') ||
    (event.ctrlKey && key === 'insert') ||
    (event.shiftKey && key === 'delete')
  );
}

/** Returns true when the event is a browser DevTools or DOM-inspector shortcut. */
function isInspectorShortcut(event: KeyboardEvent): boolean {
  const key = event.key.toLowerCase();
  const code = event.code;

  if (key === 'f12' || key === 'contextmenu') return true;

  const commandKey = event.ctrlKey || event.metaKey;
  if (!commandKey) {
    return event.shiftKey && key === 'f10';
  }

  if (event.shiftKey && (code === 'KeyI' || code === 'KeyJ' || code === 'KeyC')) {
    return true;
  }

  // macOS uses Cmd+Option+I/J/C for the same inspector actions.
  if (event.altKey && (code === 'KeyI' || code === 'KeyJ' || code === 'KeyC')) {
    return true;
  }

  // View source is another browser escape hatch.
  return !event.shiftKey && code === 'KeyU';
}

function preventDefault(event: Event): void {
  event.preventDefault();
}

/** Keeps the custom title bar's native window drag working. */
function isWindowDragRegion(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-tauri-drag-region]') !== null;
}

/**
 * Installs release-only browser guards.
 *
 * Everything is a no-op in development so DevTools and browser shortcuts keep
 * working while iterating. Production blocks the native context menu, HTML
 * drag/drop and inspector/view-source shortcuts; normal keyboard shortcuts and
 * editing controls are untouched.
 */
export function installProductionGuards(): void {
  if (!import.meta.env.PROD) return;

  window.addEventListener('contextmenu', preventDefault, { capture: true });

  // Block dragging app content out and dropping files/text into the webview.
  // The custom title bar is exempt: Tauri uses it to move the native window.
  window.addEventListener(
    'dragstart',
    (event) => {
      if (isWindowDragRegion(event.target)) return;
      event.preventDefault();
    },
    { capture: true },
  );
  window.addEventListener('dragenter', preventDefault, { capture: true });
  window.addEventListener('dragover', preventDefault, { capture: true });
  window.addEventListener('drop', preventDefault, { capture: true });

  window.addEventListener(
    'keydown',
    (event) => {
      if (isEditingShortcut(event)) return;
      if (!isInspectorShortcut(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    { capture: true },
  );
}
