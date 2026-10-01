import { describe, expect, it, vi } from 'vitest';
import {
  installProductionGuards,
  isEditableTarget,
  isEditingShortcut,
  isInspectorShortcut,
} from './productionGuards';

/**
 * A keydown event with only the fields the guards read.
 *
 * `event.target` cannot be passed to the constructor, so when a test needs one
 * the event is dispatched on that element instead — which is also the only way
 * the guard ever sees a target in the app.
 */
function keyEvent(
  init: Partial<KeyboardEventInit> & { key: string; target?: EventTarget },
): KeyboardEvent {
  const { target, ...rest } = init;
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...rest });
  if (target !== undefined) target.dispatchEvent(event);
  return event;
}

function editingTarget(tagName: string): HTMLElement {
  return document.createElement(tagName);
}

describe('isEditableTarget', () => {
  it('recognises the controls that own the keyboard', () => {
    expect(isEditableTarget(editingTarget('INPUT'))).toBe(true);
    expect(isEditableTarget(editingTarget('TEXTAREA'))).toBe(true);
    expect(isEditableTarget(editingTarget('SELECT'))).toBe(true);
  });

  it('recognises a contenteditable element', () => {
    const div = document.createElement('div');
    // jsdom does not implement `isContentEditable`, so the flag is supplied the
    // way a browser has it — as a boolean the guard can read.
    Object.defineProperty(div, 'isContentEditable', { value: true });
    expect(isEditableTarget(div)).toBe(true);
  });

  it('treats a missing contenteditable flag as "not editable", not as undecidable', () => {
    const div = document.createElement('div');
    Object.defineProperty(div, 'isContentEditable', { value: undefined });
    expect(isEditableTarget(div)).toBe(false);
  });

  it('is false for ordinary elements, non-elements and nothing at all', () => {
    expect(isEditableTarget(document.createElement('div'))).toBe(false);
    expect(isEditableTarget(document.createTextNode('text'))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('isEditingShortcut', () => {
  it('keeps copy/paste/select-all/undo inside an input', () => {
    const input = editingTarget('INPUT');
    for (const key of ['a', 'c', 'v', 'x', 'y', 'z']) {
      expect(isEditingShortcut(keyEvent({ key, ctrlKey: true, target: input }))).toBe(true);
    }
  });

  it('keeps the insert/delete editing shortcuts inside an input', () => {
    const input = editingTarget('INPUT');
    expect(isEditingShortcut(keyEvent({ key: 'Insert', shiftKey: true, target: input }))).toBe(
      true,
    );
    expect(isEditingShortcut(keyEvent({ key: 'Insert', ctrlKey: true, target: input }))).toBe(true);
    expect(isEditingShortcut(keyEvent({ key: 'Delete', shiftKey: true, target: input }))).toBe(
      true,
    );
  });

  it('does not exempt editing shortcuts outside an input', () => {
    expect(isEditingShortcut(keyEvent({ key: 'c', ctrlKey: true }))).toBe(false);
  });

  it('does not exempt ordinary keys inside an input', () => {
    const input = editingTarget('INPUT');
    expect(isEditingShortcut(keyEvent({ key: 'r', ctrlKey: true, target: input }))).toBe(false);
    expect(isEditingShortcut(keyEvent({ key: 'a', target: input }))).toBe(false);
  });
});

describe('isInspectorShortcut', () => {
  it('blocks F12 and the context-menu key', () => {
    expect(isInspectorShortcut(keyEvent({ key: 'F12' }))).toBe(true);
    expect(isInspectorShortcut(keyEvent({ key: 'ContextMenu' }))).toBe(true);
  });

  it('blocks the Ctrl+Shift+I/J/C inspector triples', () => {
    for (const code of ['KeyI', 'KeyJ', 'KeyC']) {
      expect(
        isInspectorShortcut(keyEvent({ key: code.slice(3), code, ctrlKey: true, shiftKey: true })),
      ).toBe(true);
      expect(
        isInspectorShortcut(keyEvent({ key: code.slice(3), code, metaKey: true, shiftKey: true })),
      ).toBe(true);
    }
  });

  it('blocks the macOS Cmd+Option+I/J/C triples', () => {
    for (const code of ['KeyI', 'KeyJ', 'KeyC']) {
      expect(
        isInspectorShortcut(keyEvent({ key: code.slice(3), code, metaKey: true, altKey: true })),
      ).toBe(true);
    }
  });

  it('blocks view-source and Shift+F10', () => {
    expect(isInspectorShortcut(keyEvent({ key: 'u', code: 'KeyU', ctrlKey: true }))).toBe(true);
    expect(isInspectorShortcut(keyEvent({ key: 'F10', shiftKey: true }))).toBe(true);
  });

  it('leaves reload, find and ordinary typing alone', () => {
    expect(isInspectorShortcut(keyEvent({ key: 'r', code: 'KeyR', ctrlKey: true }))).toBe(false);
    expect(isInspectorShortcut(keyEvent({ key: 'f', code: 'KeyF', ctrlKey: true }))).toBe(false);
    expect(isInspectorShortcut(keyEvent({ key: 'a' }))).toBe(false);
    // Shift+Ctrl+U is not view-source; the guard must not widen to it.
    expect(
      isInspectorShortcut(keyEvent({ key: 'u', code: 'KeyU', ctrlKey: true, shiftKey: true })),
    ).toBe(false);
  });
});

describe('installProductionGuards', () => {
  it('installs nothing outside a production build', () => {
    // Dev keeps DevTools, reload shortcuts and HMR working; a guard installed
    // here would take them away from whoever is iterating.
    const spy = vi.spyOn(window, 'addEventListener');
    installProductionGuards();
    expect(spy).not.toHaveBeenCalled();
  });
});
