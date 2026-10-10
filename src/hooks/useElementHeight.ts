import { useEffect, useState, type RefObject } from 'react';

/**
 * The content-box height of an element, kept in step with its container.
 *
 * The board takes the well's height rather than a literal so that the stage
 * never scrolls: the panels divide whatever room there is, and the copies panel
 * scrolls inside itself when its rows do not fit. This is the one measurement
 * on the routing screen, and it is deliberately a single number the whole board
 * derives from — nothing here reads a card's own box, so a row and the wire
 * meeting it still cannot disagree by a frame.
 *
 * It answers 0 until the element has been measured; the board falls back to its
 * own default height for that first frame.
 */
export function useElementHeight<T extends HTMLElement>(ref: RefObject<T | null>): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) setHeight(entry.contentRect.height);
    });
    observer.observe(element);
    setHeight(element.clientHeight);
    return () => observer.disconnect();
  }, [ref]);

  return height;
}
