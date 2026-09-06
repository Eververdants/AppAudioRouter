import { useLayoutEffect, useRef, useState } from 'react';

export interface FitScaleOptions {
  /** Lower bound of the returned scale, so content stays legible. */
  min?: number;
  /** Upper bound of the returned scale, so content does not grow unbounded. */
  max?: number;
}

/**
 * Measures the referenced container and returns a uniform scale factor that
 * fits a square stage of `designSize` px into the available space. The stage
 * keeps a fixed internal layout (positions, radii, font sizes stay in design
 * units); only its visual size changes, which keeps the geometry consistent
 * at any window size.
 */
export function useFitScale(designSize: number, { min = 0.4, max = 1.15 }: FitScaleOptions = {}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => {
      const { width, height } = el.getBoundingClientRect();
      if (width <= 0 || height <= 0) return;
      const next = Math.max(Math.min(width / designSize, height / designSize, max), min);
      setScale(next);
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [designSize, min, max]);

  return { ref, scale };
}
