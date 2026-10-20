import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScrubReadout } from './ScrubReadout';

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The typed path of the scrubbable number.
 *
 * Both `Enter` and `Escape` close the editor and hand the focus back to the host
 * span — and that `focus()` blurs the input *synchronously*, so `commit` runs a
 * second time inside the same tick, from the same render's closure. A `commit`
 * that reads the draft out of state therefore sees text React has already
 * discarded: `Enter` costs two identical writes, and `Escape` writes back the
 * very number it was supposed to abandon. These two tests are the whole reason
 * the draft lives in a ref as well as in state.
 */

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const onCommit = vi.fn();

/** Type into a React-controlled input the way a person does. */
function type(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function press(el: Element, key: string): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

function mount(): void {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <ScrubReadout
        value={100}
        min={0}
        max={400}
        step={1}
        format={(v) => String(v)}
        unit="%"
        label="Level"
        hint="Drag, scroll or type"
        neutral={false}
        onCommit={onCommit}
      />,
    );
  });
}

/** Put the host into editing with `text` sitting in the field, ready to answer. */
function edit(text: string): HTMLInputElement {
  const host = container?.querySelector<HTMLElement>('[role="slider"]');
  if (!host) throw new Error('no slider host rendered');
  host.focus();
  press(host, 'Enter');
  const input = container?.querySelector('input');
  if (!input) throw new Error('the field did not open for typing');
  input.focus();
  type(input, text);
  onCommit.mockClear();
  return input;
}

beforeEach(() => {
  onCommit.mockClear();
  mount();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe('ScrubReadout typing', () => {
  it('commits a typed figure exactly once, and clamps it', () => {
    const input = edit('150');
    press(input, 'Enter');
    expect(onCommit.mock.calls).toEqual([[150]]);

    // A figure past the ceiling is written clamped, not as typed and not twice.
    const wide = edit('99999');
    press(wide, 'Enter');
    expect(onCommit.mock.calls).toEqual([[400]]);
  });

  it('abandons a typed figure on Escape without writing it', () => {
    const input = edit('222');
    press(input, 'Escape');
    expect(onCommit).not.toHaveBeenCalled();
    // The key went back to the host span, not to the document.
    expect(document.activeElement).toBe(container?.querySelector('[role="slider"]') ?? null);
  });
});
