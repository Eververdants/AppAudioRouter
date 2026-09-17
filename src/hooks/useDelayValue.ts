import { useRef, useState } from 'react';
import { clampDelay, formatStep, stepDelay } from '@/lib/delay';
import { useRouterStore } from '@/stores/routerStore';

/**
 * Editing state for one device's delay compensation, shared by the controls
 * that expose it (the capsule on the router stage and the settings rows).
 *
 * The field keeps a local draft while it is being typed in and commits on blur
 * (persist + notify the engine); the store applies the change optimistically
 * and rolls it back if the backend rejects it.
 */
export function useDelayValue(deviceId: string, rangeMs: number) {
  const committed = useRouterStore((s) => s.deviceDelays[deviceId] ?? 0);
  const stepMs = useRouterStore((s) => s.delayStepMs);
  const setDeviceDelayValue = useRouterStore((s) => s.setDeviceDelayValue);
  /** Text being typed; `null` while the field mirrors the committed value. */
  const [draft, setDraft] = useState<string | null>(null);
  /** Set by Escape so the blur it triggers reverts instead of committing. */
  const reverting = useRef(false);

  const commit = () => {
    const raw = draft;
    setDraft(null);
    if (reverting.current) {
      reverting.current = false;
      return;
    }
    if (raw === null) return;
    const parsed = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(parsed)) return;
    void setDeviceDelayValue(deviceId, clampDelay(parsed, rangeMs));
  };

  /**
   * Step by the configured amount, `times` times at once (a wheel notch or a
   * shifted arrow key covers more ground than a single click).
   */
  const nudge = (direction: 1 | -1, times = 1) => {
    const raw = draft;
    setDraft(null);
    // Clicking a step button blurs the field first, which commits whatever was
    // typed; step from that value so the click never discards the edit.
    const parsed = raw !== null && raw.trim() !== '' ? Number(raw) : Number.NaN;
    const base = Number.isFinite(parsed) ? parsed : committed;
    void setDeviceDelayValue(deviceId, stepDelay(base, direction, rangeMs, stepMs, times));
  };

  /** Escape abandons the draft instead of committing it on blur. */
  const cancel = () => {
    reverting.current = true;
  };

  return {
    committed,
    draft,
    setDraft,
    commit,
    nudge,
    cancel,
    stepMs,
    stepLabel: formatStep(stepMs),
    atMin: committed <= -rangeMs,
    atMax: committed >= rangeMs,
  };
}
