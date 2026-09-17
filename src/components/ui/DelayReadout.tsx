import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clampDelay, formatDelaySigned } from '@/lib/delay';
import { useDelayValue } from '@/hooks/useDelayValue';
import { useRouterStore } from '@/stores/routerStore';

/** Horizontal travel worth one step: short enough that a flick lands on the
 *  next value, long enough that a press meant as a click stays one. */
const PX_PER_STEP = 4;
/** Travel after which a press counts as a scrub rather than a click. */
const DRAG_SLOP_PX = 3;

/**
 * One device's delay, as a number on the trailing edge of its node capsule.
 *
 * The number *is* the control — there are no −/+ buttons to give it company, so
 * the capsule keeps one width whether it is being read or being edited:
 *
 * - drag sideways to scrub, one configured step per few pixels;
 * - wheel (or arrow keys) to step, shifted for ten steps at a time;
 * - click to type an exact figure.
 *
 * A scrub reports its value locally and commits once, when the pointer is
 * released: a drag should leave one entry in the log, not one per pixel.
 * Stepping and typing commit right away, so the engine follows along.
 */
export function DelayReadout({
  deviceId,
  name,
  rangeMs,
}: {
  deviceId: string;
  name: string;
  rangeMs: number;
}) {
  const { t } = useTranslation();
  const delaySync = useRouterStore((s) => s.delaySync);
  const setDeviceDelayValue = useRouterStore((s) => s.setDeviceDelayValue);
  const { committed, draft, setDraft, commit, nudge, cancel, stepMs, stepLabel } = useDelayValue(
    deviceId,
    rangeMs,
  );
  const [editing, setEditing] = useState(false);
  /** Value shown mid-scrub; `null` when the field simply mirrors the store. */
  const [scrub, setScrub] = useState<number | null>(null);
  const hostRef = useRef<HTMLSpanElement>(null);
  const drag = useRef<{ x: number; from: number; moved: boolean } | null>(null);

  // React registers `wheel` passively, where `preventDefault` is ignored — the
  // listener has to be attached by hand to keep a scroll over the stage from
  // also scrolling whatever is behind it.
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const onWheel = (e: WheelEvent) => {
      if (editing) return;
      e.preventDefault();
      nudge(e.deltaY < 0 ? 1 : -1, e.shiftKey ? 10 : 1);
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, [editing, nudge]);

  const shown = scrub ?? committed;
  const hint = t('deviceDelay.hint', { step: stepLabel });
  const title = delaySync ? hint : `${hint}\n${t('deviceDelay.syncOff')}`;

  const endDrag = (finish: boolean) => {
    const state = drag.current;
    if (state === null) return;
    drag.current = null;
    const next = scrub;
    setScrub(null);
    if (!state.moved) {
      setEditing(true);
      return;
    }
    if (finish && next !== null && next !== committed) void setDeviceDelayValue(deviceId, next);
  };

  return (
    <span
      ref={hostRef}
      role={editing ? undefined : 'slider'}
      tabIndex={editing ? -1 : 0}
      aria-label={t('deviceDelay.valueLabel', { device: name })}
      aria-valuemin={-rangeMs}
      aria-valuemax={rangeMs}
      aria-valuenow={committed}
      aria-valuetext={`${shown} ms`}
      title={title}
      onPointerDown={(e) => {
        if (editing || e.button !== 0) return;
        drag.current = { x: e.clientX, from: committed, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const state = drag.current;
        if (state === null) return;
        const dx = e.clientX - state.x;
        if (!state.moved && Math.abs(dx) < DRAG_SLOP_PX) return;
        state.moved = true;
        setScrub(clampDelay(state.from + Math.trunc(dx / PX_PER_STEP) * stepMs, rangeMs));
      }}
      onPointerUp={() => endDrag(true)}
      onPointerCancel={() => endDrag(false)}
      onKeyDown={(e) => {
        if (editing) return;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
          e.preventDefault();
          nudge(1, e.shiftKey ? 10 : 1);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
          e.preventDefault();
          nudge(-1, e.shiftKey ? 10 : 1);
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setEditing(true);
        }
      }}
      className={`group/delay relative flex h-4 min-w-[50px] flex-none cursor-ew-resize select-none touch-none items-center rounded-full pl-1.5 outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-accent/60 ${
        delaySync ? '' : 'opacity-50'
      }`}
    >
      <span aria-hidden="true" className="mr-1.5 h-3 w-px flex-none bg-border" />
      {editing ? (
        <input
          autoFocus
          type="text"
          inputMode="numeric"
          value={draft ?? String(committed)}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => {
            commit();
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commit();
              setEditing(false);
            }
            if (e.key === 'Escape') {
              // `commit` is what clears the draft; the flag only stops it from
              // writing, and it also defuses the blur the unmount may fire.
              cancel();
              commit();
              setEditing(false);
            }
          }}
          aria-label={t('deviceDelay.valueLabel', { device: name })}
          className="min-w-0 flex-1 bg-transparent text-right text-[10px] font-medium tabular-nums text-accent outline-none"
        />
      ) : (
        <span
          className={`min-w-0 flex-1 text-right text-[10px] font-medium tabular-nums transition-transform duration-100 ${
            scrub === null ? 'text-accent' : 'scale-110 text-accent'
          }`}
        >
          {formatDelaySigned(shown)}
        </span>
      )}
      <span className="ml-px flex-none text-[8px] leading-none text-text-muted">ms</span>
      {/* Hairline underline: the only hint that the number is live, and it
          costs no width, so the capsule is the same object at rest. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-2 bottom-px h-px bg-transparent transition-colors group-hover/delay:bg-accent/40 group-focus-visible/delay:bg-accent/40"
      />
    </span>
  );
}
