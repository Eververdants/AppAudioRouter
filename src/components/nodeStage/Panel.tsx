import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { FADE, MAIN_THREAD_TRANSFORM } from '@/lib/motion';
import {
  GROUP_HEADER_H,
  GROUP_PAD,
  GROUP_W,
  GROUP_X,
  PANEL_BORDER,
  ROW_H,
  panelBodyHeight,
  rowContentY,
} from '@/lib/stage';

/**
 * One of the two grouped panels down the right edge.
 *
 * A dashed rounded rectangle rather than a solid one: the panel holds cards,
 * so it must not read as a card itself. Its title row stays put while the rows
 * below it scroll, because the way in for a new direction has to be reachable
 * however long the list has grown.
 */
export function Panel({
  label,
  top,
  height,
  rows,
  empty,
  headerAction,
  onScroll,
  resetKey,
  revealIndex,
  onRevealed,
  children,
}: {
  label: string;
  top: number;
  height: number;
  rows: number;
  empty: string;
  headerAction?: React.ReactNode;
  onScroll?: (scrollTop: number) => void;
  /** Changing this sends the panel back to its top. The scroll position lives
   *  in the DOM, where no parent state can reach it: a programme switch resets
   *  the wires' scroll and leaves the rows where they were, so every wire ends
   *  up pointing at the place its row used to hold. */
  resetKey?: string | number;
  /** One-shot: the row index to bring into view; handed back via
   *  `onRevealed` once the panel has done its single scroll. */
  revealIndex?: number | null;
  onRevealed?: () => void;
  children: React.ReactNode;
}) {
  const bodyHeight = height - PANEL_BORDER * 2 - GROUP_HEADER_H;
  const contentHeight = rows > 0 ? panelBodyHeight(rows) : 0;
  const [scrollTop, setScrollTop] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // When the content or the room changes, the browser clamps the scroll itself;
  // read the clamped value back so a hint does not stay lit over a panel that
  // has just come to rest at its new bottom — and report it too, so the wires
  // that ride the parent's `copyScroll` do not keep pointing where the rows were
  // before the clamp.
  useEffect(() => {
    const clamped = scrollRef.current?.scrollTop ?? 0;
    setScrollTop(clamped);
    onScroll?.(clamped);
  }, [rows, bodyHeight, onScroll]);
  // A new programme on the hub means a new list of rows, and the panel starts
  // at its top for it — the DOM's own scroll is reset here, because the parent
  // can reset only the number it draws wires from.
  useEffect(() => {
    if (resetKey === undefined) return;
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = 0;
    setScrollTop(0);
    onScroll?.(0);
  }, [resetKey]);
  // A destination that has just joined the plan may have landed below the cut:
  // one instant scroll brings its row fully into view — the row's own entrance
  // spring carries the "it arrived" moment, and the wire draws in after the
  // scroll settles it. It only ever reaches down: a row the eye can already
  // see never pulls the panel back up.
  useEffect(() => {
    if (revealIndex === undefined || revealIndex === null) return;
    const el = scrollRef.current;
    if (el === null) return;
    const maxScroll = Math.max(0, contentHeight - bodyHeight);
    const target = rowContentY(revealIndex) + ROW_H / 2 + GROUP_PAD - bodyHeight;
    const next = Math.max(el.scrollTop, Math.min(target, maxScroll));
    if (next !== el.scrollTop) {
      el.scrollTop = next;
      // Reported here as well as through the scroll event the DOM fires a task
      // later: the wires are drawn from the parent's copy of the scroll, and
      // waiting for that event would spend one frame with every line pointing at
      // where its row sat before the reveal.
      setScrollTop(next);
      onScroll?.(next);
    }
    onRevealed?.();
  }, [revealIndex, bodyHeight, contentHeight, onScroll, onRevealed]);
  const canScrollUp = rows > 0 && scrollTop > 0.5;
  const canScrollDown = rows > 0 && scrollTop + bodyHeight < contentHeight - 0.5;
  return (
    <div
      className="cc absolute overflow-hidden rounded-card border border-dashed border-line-strong bg-surface-sunken"
      style={{ left: GROUP_X, top, width: GROUP_W, height }}
    >
      <div
        className="flex items-center justify-between gap-2 px-2"
        style={{ height: GROUP_HEADER_H }}
      >
        <span className="truncate text-xs font-semibold uppercase tracking-[0.08em] text-text-muted">
          {label}
        </span>
        {headerAction}
      </div>
      <div className="relative" style={{ height: bodyHeight }}>
        <div
          ref={scrollRef}
          className="h-full overflow-y-auto"
          onScroll={(event) => {
            setScrollTop(event.currentTarget.scrollTop);
            onScroll?.(event.currentTarget.scrollTop);
          }}
        >
          {rows > 0 ? (
            <div className="relative" style={{ height: contentHeight }}>
              {children}
            </div>
          ) : (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={FADE}
              transformTemplate={MAIN_THREAD_TRANSFORM}
              className="px-3 py-2.5 text-xs leading-relaxed text-text-muted"
            >
              {empty}
            </motion.div>
          )}
        </div>
        {/* The soft edge: the panel's own background closing over whatever runs
            past it. It is what makes the half-row cut below read as "there is
            more down there" rather than as a card that failed to render — a
            gentle pull towards the content that is out of sight, fading in only
            while there is something on that side to reach. Never interactive,
            and it paints nothing while the rows fit. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-4 bg-gradient-to-b from-surface-sunken to-transparent transition-opacity duration-200"
          style={{ opacity: canScrollUp ? 1 : 0 }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-surface-sunken to-transparent transition-opacity duration-200"
          style={{ opacity: canScrollDown ? 1 : 0 }}
        />
      </div>
    </div>
  );
}
