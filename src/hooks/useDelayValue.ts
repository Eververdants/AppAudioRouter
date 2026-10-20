import { useEffect, useRef, useState } from 'react';
import { DELAY_MAX_MS, clampDelay, formatStep, stepDelay } from '@/lib/delay';
import { useRouterStore } from '@/stores/routerStore';

/** The text being typed, together with the device it was typed *for*. */
interface Draft {
  deviceId: string;
  text: string;
}

/**
 * Editing state for one device's delay compensation, shared by the controls
 * that expose it (the capsule on the router stage and the settings rows).
 *
 * The field keeps a local draft while it is being typed in and commits on blur
 * (persist + notify the engine); the store applies the change optimistically and
 * rolls it back if the backend rejects it.
 *
 * The draft carries its device on purpose. The value on screen belongs to the
 * hardware the user was looking at, and nothing may write it somewhere else:
 * `deviceId` is a prop, so a control that is not keyed by it — or a device
 * removed from the list above this one — would otherwise hand device A's typed
 * number to device B, a delay the user never asked for and cannot see being
 * wrong. So every write goes to `draft.deviceId`, and a draft from another
 * device is invisible to this one: the field reads as the device it now names.
 *
 * The other half of the same promise: a draft the user can see is never
 * discarded by the field going away. Typing 250 and then having the row
 * disappear (the device dropped out, the settings page closed) used to leave the
 * number in the input's memory and nothing in the config — an unmount flushes
 * it, exactly as a blur would. Escape is the one way to abandon an edit, and it
 * still does.
 */
export function useDelayValue(deviceId: string) {
  const committed = useRouterStore((s) => s.deviceDelays[deviceId] ?? 0);
  const stepMs = useRouterStore((s) => s.delayStepMs);
  const setDeviceDelayValue = useRouterStore((s) => s.setDeviceDelayValue);
  /** Text being typed; `null` while the field mirrors the committed value. */
  const [draft, setDraftState] = useState<Draft | null>(null);
  /** Set by Escape so the blur it triggers reverts instead of committing. */
  const reverting = useRef(false);

  /** Write a held draft back to the device it was typed for. Never to another. */
  const flush = (held: Draft | null): void => {
    if (held === null) return;
    const parsed = Number(held.text);
    if (held.text.trim() === '' || !Number.isFinite(parsed)) return;
    void setDeviceDelayValue(held.deviceId, clampDelay(parsed));
  };

  // What the unmount flush reads, captured at the moment the field is torn down
  // rather than at the moment the effect ran: an effect with no dependencies
  // closes over the first render's draft, which is none.
  const live = useRef({ draft, flush, reverting });
  live.current = { draft, flush, reverting };
  useEffect(
    () => () => {
      const held = live.current;
      // Escape had already abandoned this edit; a field disappearing is not a
      // reason to write the number it was showing.
      if (held.reverting.current) return;
      held.flush(held.draft);
    },
    [],
  );

  const commit = () => {
    const held = draft;
    setDraftState(null);
    if (reverting.current) {
      reverting.current = false;
      return;
    }
    flush(held);
  };

  /**
   * Step by the configured amount, `times` times at once (a wheel notch or a
   * shifted arrow key covers more ground than a single click).
   */
  const nudge = (direction: 1 | -1, times = 1) => {
    const held = draft;
    setDraftState(null);
    // A draft left over from another device is written back where it belongs
    // before this one moves: stepping B is not a licence to lose A's number.
    if (held !== null && held.deviceId !== deviceId) flush(held);
    // Clicking a step button blurs the field first, which commits whatever was
    // typed; step from that value so the click never discards the edit.
    const raw = held !== null && held.deviceId === deviceId ? held.text : null;
    const parsed = raw !== null && raw.trim() !== '' ? Number(raw) : Number.NaN;
    const base = Number.isFinite(parsed) ? parsed : committed;
    void setDeviceDelayValue(deviceId, stepDelay(base, direction, stepMs, times));
  };

  /** Escape abandons the draft instead of committing it on blur. */
  const cancel = () => {
    reverting.current = true;
  };

  /** The draft only shows on the device it was typed for. */
  const editing = draft !== null && draft.deviceId === deviceId ? draft.text : null;

  return {
    committed,
    draft: editing,
    /** Replace the typed text for *this* device, or clear it with `null`. */
    setDraft: (text: string | null) => setDraftState(text === null ? null : { deviceId, text }),
    commit,
    nudge,
    cancel,
    stepMs,
    stepLabel: formatStep(stepMs),
    atMin: committed <= -DELAY_MAX_MS,
    atMax: committed >= DELAY_MAX_MS,
  };
}
