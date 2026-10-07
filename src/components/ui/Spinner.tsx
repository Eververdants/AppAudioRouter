/**
 * The loading mark: a concentric ring with one quadrant missing, turning.
 *
 * The interface's every indicator is two circles sharing a centre; the spinner
 * is that same mark caught mid-turn — the ring is the promise, the gap is the
 * part still on its way. Drawn in `currentColor`, so the caller decides the
 * tone and the spinner stays one shape everywhere it appears. Tailwind's
 * `animate-spin` runs it, and `prefers-reduced-motion` stops it there: a
 * resting spinner reads as a quiet ring rather than as progress, which is the
 * honest thing for a machine that has been asked not to move.
 */
export function Spinner({ size = 12, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={`animate-spin motion-reduce:animate-none ${className}`}
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="28 10"
      />
    </svg>
  );
}
