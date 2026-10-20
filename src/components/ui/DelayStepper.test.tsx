import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DelayStepper } from './DelayStepper';

(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The two keys the field answers to, at the control that offers them.
 *
 * `useDelayValue` owns the draft and its device, and the commit-on-blur that
 * follows a focus move — so the wiring in this row is the thin end of the wedge:
 * `Enter` writes once and keeps the caret, `Escape` abandons and hands the focus
 * to the wrapper, whose blur then fires the commit the hook defuses. Getting
 * either half wrong costs a second write of the same number, or writes back the
 * number `Escape` was meant to drop; the hook's own tests cannot see either,
 * because both are about *this* component's key handlers.
 */

const { state } = vi.hoisted(() => ({
  state: {
    deviceDelays: {} as Record<string, number>,
    delayStepMs: 5,
    setDeviceDelayValue: vi.fn(() => Promise.resolve(true)),
  },
}));

vi.mock('@/stores/routerStore', () => ({
  useRouterStore: (selector: (s: typeof state) => unknown) => selector(state),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(): void {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<DelayStepper deviceId="dev-a" name="Speakers" />);
  });
}

function field(): HTMLInputElement {
  const input = container?.querySelector('input');
  if (!input) throw new Error('the stepper renders no value field');
  return input;
}

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

beforeEach(() => {
  state.setDeviceDelayValue.mockClear();
  state.deviceDelays = {};
  mount();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe('DelayStepper keys', () => {
  it('writes a typed figure once on Enter and leaves the caret in the field', () => {
    const input = field();
    input.focus();
    type(input, '250');
    press(input, 'Enter');
    expect(state.setDeviceDelayValue.mock.calls).toEqual([['dev-a', 250]]);
    expect(document.activeElement).toBe(input);
  });

  it('abandons a typed figure on Escape and hands the focus to the wrapper', () => {
    const input = field();
    input.focus();
    type(input, '77');
    state.setDeviceDelayValue.mockClear();
    press(input, 'Escape');
    // The blur the focus move fires must not turn the abandonment into a write.
    expect(state.setDeviceDelayValue).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(container?.querySelector('div[tabindex="-1"]') ?? null);
    // And the field goes back to the number that stands.
    expect(field().value).toBe('0');
  });

  it('clamps a typed figure to the engine bounds before writing it', () => {
    const input = field();
    input.focus();
    type(input, '999999');
    press(input, 'Enter');
    expect(state.setDeviceDelayValue.mock.calls).toEqual([['dev-a', 10000]]);
  });
});
