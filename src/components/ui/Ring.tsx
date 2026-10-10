/**
 * The concentric indicator — the mark the whole interface is made of.
 *
 * Two circles sharing a centre, with nothing drawn in the space between them:
 * the outer ring says what a thing *is*, and the core says whether it is
 * happening. Everything that can be lit or assigned wears one, at whatever size
 * the row it sits in affords, so a device's state and a program's state are the
 * same shape seen twice rather than two different badges.
 *
 * The drawing itself lives in styles/index.css: sizing per instance has to come
 * from the caller, and a ring whose size is decided in three places would drift.
 * The class names here are literal because Tailwind scans source text — a class
 * assembled at runtime is a class that never gets generated.
 */
export type RingTone = 'main' | 'copy' | 'idle';

const TONE_CLASS: Record<RingTone, string> = {
  main: 'con-ring-main',
  copy: 'con-ring-copy',
  idle: 'con-ring-idle',
};

export function Ring({
  tone = 'idle',
  size = 16,
  live = false,
  className = '',
}: {
  /** What the thing wearing it is doing: played by the system, a copy of it,
   *  or nothing at all. */
  tone?: RingTone;
  /** Outer diameter, in px. */
  size?: number;
  /** Sound is coming out of this one right now. */
  live?: boolean;
  className?: string;
}) {
  const classes = ['con-ring', TONE_CLASS[tone], live ? 'con-ring-live' : '', className]
    .filter(Boolean)
    .join(' ');
  return <span aria-hidden="true" className={classes} style={{ width: size, height: size }} />;
}
