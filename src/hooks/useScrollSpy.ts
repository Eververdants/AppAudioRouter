import { useEffect, useState } from 'react';

/** Tracks which of the given section ids currently crosses the reading band
 *  of the viewport, for the header's sliding active indicator. */
export function useScrollSpy(ids: readonly string[]): string | null {
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActiveId(entry.target.id);
        }
      },
      // A narrow horizontal band around the upper third of the viewport: the
      // section crossing it is the one being read.
      { rootMargin: '-35% 0px -55% 0px' },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [ids]);

  return activeId;
}
