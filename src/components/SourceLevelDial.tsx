import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrubReadout } from '@/components/ui/ScrubReadout';
import { useRouterStore } from '@/stores/routerStore';

/** Upper bound of a program's level, in percent — about +12 dB, past which the
 *  noise floor rises with the signal. Kept in step with `SOURCE_VOLUME_MAX` on
 *  the Rust side; the two are literals and nothing binds them together. */
const SOURCE_LEVEL_MAX = 400;
/** 100 is the audio as the program produced it, the middle of the range rather
 *  than its top. */
const SOURCE_LEVEL_NEUTRAL = 100;
const SOURCE_LEVEL_STEP = 5;
const SOURCE_LEVEL_PX_PER_STEP = 3;

/** Ring geometry, in the 16×16 box the arc is drawn in. */
const RADIUS = 6.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * The ring beside the number.
 *
 * One ring, several facts: the arc is the level (full at 100 and beyond — a
 * level above neutral is amplification, and the number is the truth the rim
 * cannot carry), its colour says whether the value is at neutral, and it is
 * drawn from the value *currently shown* so it moves with the gesture instead
 * of catching up on commit. A zero arc is not drawn at all: a round linecap
 * turns even an empty dash into a dot, and 0 % is not a small value, it is
 * silence.
 */
function levelRing(shown: number): ReactNode {
  const fraction = Math.max(0, Math.min(1, shown / SOURCE_LEVEL_NEUTRAL));
  const neutral = shown === SOURCE_LEVEL_NEUTRAL;
  return (
    <svg
      aria-hidden="true"
      width={16}
      height={16}
      viewBox="0 0 16 16"
      className="flex-none"
    >
      <circle cx={8} cy={8} r={RADIUS} fill="none" stroke="var(--hairline-strong)" strokeWidth={2} />
      {fraction > 0 && (
        <circle
          cx={8}
          cy={8}
          r={RADIUS}
          fill="none"
          stroke={neutral ? 'var(--text-muted)' : 'var(--accent)'}
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={`${fraction * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
          transform="rotate(-90 8 8)"
        />
      )}
    </svg>
  );
}

/**
 * One program's level, as the ring the source node wears.
 *
 * The level belongs to the program by executable name — the same ownership rule
 * the routes use — and only means anything while a duplication engine is
 * carrying its audio: the dial is shown exactly where that is true, on the
 * nodes of programs whose route has at least two devices. The interaction is
 * the shared "the number is the control": drag, wheel, arrow keys, or click to
 * type.
 */
export function SourceLevelDial({ exeName }: { exeName: string }) {
  const { t } = useTranslation();
  const committed = useRouterStore((s) => s.sourceVolumes[exeName] ?? SOURCE_LEVEL_NEUTRAL);
  const setSourceVolume = useRouterStore((s) => s.setSourceVolume);

  return (
    <ScrubReadout
      value={committed}
      min={0}
      max={SOURCE_LEVEL_MAX}
      step={SOURCE_LEVEL_STEP}
      pxPerStep={SOURCE_LEVEL_PX_PER_STEP}
      format={(value) => String(value)}
      unit="%"
      label={t('sourceLevel.valueLabel', { process: exeName })}
      hint={t('sourceLevel.hint', { step: SOURCE_LEVEL_STEP })}
      neutral={committed === SOURCE_LEVEL_NEUTRAL}
      lead={levelRing}
      onCommit={(next) => void setSourceVolume(exeName, next)}
    />
  );
}
