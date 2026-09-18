import { useEffect, useRef, useState } from 'react';

/** Travel after which a press counts as a scrub rather than a click. */
const DRAG_SLOP_PX = 3;

export interface ScrubReadoutProps {
  /** Committed value, owned by the store. */
  value: number;
  min: number;
  max: number;
  /** Amount one step changes, and the grid values snap to. */
  step: number;
  /** Horizontal travel, in CSS pixels, that amounts to one step. */
  pxPerStep?: number;
  /** Render one value as text; gets the committed or previewed number. */
  format: (value: number) => string;
  /** Unit shown after the number, smaller and muted. */
  unit: string;
  /** Accessible name of the field. */
  label: string;
  /** Tooltip: how the number is edited. */
  hint: string;
  /** Whether the value is at its neutral state, which reads muted. */
  neutral: boolean;
  /** Dim the control (e.g. the feature behind it is off). */
  dim?: boolean;
  onCommit: (value: number) => void;
}

/**
 * One scrubbable number: the value *is* the control.
 *
 * There are no −/+ buttons to give it company, so it takes no more room than
 * the number itself:
 *
 * - drag sideways to scrub, one step per few pixels;
 * - wheel, or arrow keys, to step (Shift for ten steps at a time);
 * - click to type an exact figure.
 *
 * A scrub reports its value locally and commits once, when the pointer is
 * released: a gesture should leave one entry in the log, not one per pixel.
 * Stepping and typing commit right away, so the engine follows along.
 */
export function ScrubReadout({
  value,
  min,
  max,
  step,
  pxPerStep = 4,
  format,
  unit,
  label,
  hint,
  neutral,
  dim = false,
  onCommit,
}: ScrubReadoutProps) {
  const [editing, setEditing] = useState(false);
  /** Text being typed; `null` while the field mirrors the committed value. */
  const [draft, setDraft] = useState<string | null>(null);
  /** Value shown mid-scrub; `null` when the field mirrors the store. */
  const [scrub, setScrub] = useState<number | null>(null);
  const hostRef = useRef<HTMLSpanElement>(null);
  const drag = useRef<{ x: number; from: number; moved: boolean } | null>(null);
  /** Set by Escape so the blur it triggers reverts instead of committing. */
  const reverting = useRef(false);

  const clamp = (raw: number) => Math.max(min, Math.min(max, Math.round(raw)));
  const shown = scrub ?? value;

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
    onCommit(clamp(parsed));
  };

  const stepBy = (direction: 1 | -1, times = 1) => {
    const typed = draft !== null && draft.trim() !== '' ? Number(draft) : Number.NaN;
    const base = Number.isFinite(typed) ? typed : value;
    setDraft(null);
    // Snap first, so a value left behind by a coarser step lands on the grid.
    const snapped = Math.round(base / step) * step;
    onCommit(clamp(snapped + direction * step * times));
  };

  // React registers `wheel` passively, where `preventDefault` is ignored — the
  // listener has to be attached by hand to keep a scroll over the stage from
  // also scrolling whatever is behind it. The handler reads the latest closure
  // through a ref, so re-subscribing per render is not needed.
  const latest = useRef({ stepBy, editing });
  useEffect(() => {
    latest.current = { stepBy, editing };
  });
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const onWheel = (e: WheelEvent) => {
      if (latest.current.editing) return;
      e.preventDefault();
      latest.current.stepBy(e.deltaY < 0 ? 1 : -1, e.shiftKey ? 10 : 1);
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
  }, []);

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
    if (finish && next !== null && next !== value) onCommit(next);
  };

  return (
    <span
      ref={hostRef}
      role={editing ? undefined : 'slider'}
      tabIndex={editing ? -1 : 0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${shown}${unit}`}
      title={hint}
      onPointerDown={(e) => {
        if (editing || e.button !== 0) return;
        drag.current = { x: e.clientX, from: shown, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const state = drag.current;
        if (state === null) return;
        const dx = e.clientX - state.x;
        if (!state.moved && Math.abs(dx) < DRAG_SLOP_PX) return;
        state.moved = true;
        setScrub(clamp(state.from + Math.trunc(dx / pxPerStep) * step));
      }}
      onPointerUp={() => endDrag(true)}
      onPointerCancel={() => endDrag(false)}
      onKeyDown={(e) => {
        if (editing) return;
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
          e.preventDefault();
          stepBy(1, e.shiftKey ? 10 : 1);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
          e.preventDefault();
          stepBy(-1, e.shiftKey ? 10 : 1);
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          setEditing(true);
        }
      }}
      className={`group/scrub relative flex h-4 cursor-ew-resize select-none touch-none items-center justify-center gap-px rounded-sm px-1 outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-accent/60 ${
        dim ? 'opacity-50' : ''
      }`}
    >
      {editing ? (
        <input
          autoFocus
          type="text"
          inputMode="numeric"
          value={draft ?? String(value)}
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
              reverting.current = true;
              commit();
              setEditing(false);
            }
          }}
          aria-label={label}
          className="w-[38px] flex-none bg-transparent text-center text-[10px] font-medium tabular-nums text-accent outline-none"
        />
      ) : (
        <span
          className={`text-[10px] font-medium tabular-nums transition-[color,transform] duration-100 ${
            neutral
              ? 'text-text-muted group-hover/scrub:text-accent group-focus-within/scrub:text-accent'
              : 'text-accent'
          } ${scrub === null ? '' : 'scale-110'}`}
        >
          {format(shown)}
        </span>
      )}
      <span className="flex-none text-[8px] leading-none text-text-muted">{unit}</span>
      {/* Hairline underline: the only hint that the number is live, and it
          costs no width, so the annotation never moves. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-transparent transition-colors group-hover/scrub:bg-accent/40 group-focus-visible/scrub:bg-accent/40"
      />
    </span>
  );
}
