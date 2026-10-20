import { useEffect, type RefObject } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrubReadout } from '@/components/ui/ScrubReadout';
import { SOURCE_LEVEL_MAX } from '@/lib/types';
import { useRouterStore } from '@/stores/routerStore';

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
    <svg aria-hidden="true" width={16} height={16} viewBox="0 0 16 16" className="flex-none">
      <circle
        cx={8}
        cy={8}
        r={RADIUS}
        fill="none"
        stroke="var(--hairline-strong)"
        strokeWidth={2}
      />
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
 *
 * The dial is the board's, but the focus it holds is the window's: the route can
 * come down to one device, or the program can leave the session list, while the
 * caret sits inside the number. A control that goes away has to say where the
 * keyboard goes next, so it hands the focus to the card it was mounted under —
 * the same bargain `ScrubReadout` strikes with its own host when `Enter` or
 * `Escape` closes the field it is typing in.
 */
export function SourceLevelDial({
  exeName,
  displayName,
  hostRef,
}: {
  /** The storage key: the level belongs to the program by executable name. */
  exeName: string;
  /** What the label says — the display name, when the backend found one. */
  displayName?: string;
  /** The card this dial is mounted under: where the focus goes when it leaves. */
  hostRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const committed = useRouterStore((s) => s.sourceVolumes[exeName] ?? SOURCE_LEVEL_NEUTRAL);
  const setSourceVolume = useRouterStore((s) => s.setSourceVolume);

  // Removing the focused element from the DOM leaves the caret on the body, so
  // that is how this knows the focus was its own to give back. Anything else —
  // a press that landed somewhere, a programme switch that moved it on — has
  // already answered the question, and this must not reach over it.
  useEffect(() => {
    return () => {
      if (document.activeElement === document.body) hostRef.current?.focus();
    };
  }, [hostRef]);

  return (
    <ScrubReadout
      // The number is the program's, and so is everything mid-gesture: the
      // field keeps a typed draft and a wheel step waiting for its quiet
      // period locally. Without this the hub swapping programmes would hand
      // that pending figure to the *next* program's `onCommit`.
      key={exeName}
      value={committed}
      min={0}
      max={SOURCE_LEVEL_MAX}
      step={SOURCE_LEVEL_STEP}
      pxPerStep={SOURCE_LEVEL_PX_PER_STEP}
      format={(value) => String(value)}
      unit="%"
      label={t('sourceLevel.valueLabel', { process: displayName ?? exeName })}
      hint={t('sourceLevel.hint', { step: SOURCE_LEVEL_STEP })}
      neutral={committed === SOURCE_LEVEL_NEUTRAL}
      lead={levelRing}
      onCommit={(next) => void setSourceVolume(exeName, next)}
    />
  );
}
