import { type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { useSectionLabel } from '@/components/settings/hooks/useSectionLabel';
import { SPRING_GLIDE } from '@/lib/motion';

/** The sections the settings rail can show, in the order it lists them. */
export type SettingsSection =
  'appearance' | 'routing' | 'background' | 'delays' | 'levels' | 'about';

/** The rail's glyphs, one per section. Drawn once and reused by the nav. */
const SECTION_ICONS: Record<SettingsSection, ReactNode> = {
  appearance: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  ),
  routing: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  ),
  background: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3v11" />
      <path d="M8 10.5 12 14.5 16 10.5" />
      <path d="M4 17.5h16" />
    </svg>
  ),
  delays: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
    >
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15.5 13.5" />
    </svg>
  ),
  levels: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
    >
      <line x1="4" y1="6" x2="20" y2="6" />
      <circle cx="9" cy="6" r="2" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <circle cx="15" cy="12" r="2" />
      <line x1="4" y1="18" x2="20" y2="18" />
      <circle cx="7" cy="18" r="2" />
    </svg>
  ),
  about: (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  ),
};

/**
 * The rail: the back button, one row per section, and the version at the foot.
 *
 * The chosen one is marked by a rule that travels rather than by a pill that
 * blinks on and off — the same `layoutId` pane the process list's selection
 * uses, so a switch reads as the mark moving. The pane is the page's only one,
 * which is why the rail owns it and the content column does not.
 */
export function Rail({
  section,
  setSection,
  onBack,
  backRef,
}: {
  section: SettingsSection;
  setSection: (section: SettingsSection) => void;
  onBack: () => void;
  /** The back button, so a keyboard turned out of a dialog below it still has a
   *  landing spot when the control that opened that dialog has gone. */
  backRef: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useTranslation();
  const sectionLabel = useSectionLabel();

  const SECTIONS: SettingsSection[] = [
    'appearance',
    'routing',
    'background',
    'delays',
    'levels',
    'about',
  ];

  return (
    <nav
      aria-label={t('settings.title')}
      className="flex w-[190px] flex-none flex-col gap-0.5 border-r border-line px-2.5 py-3"
    >
      <button
        type="button"
        ref={backRef}
        onClick={onBack}
        className="pressable mb-2 flex items-center gap-1.5 self-start rounded-ctl px-2 py-1.5 text-[11px] font-medium text-text-muted outline-none hover:bg-surface-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <line x1="19" y1="12" x2="5" y2="12" />
          <polyline points="12 19 5 12 12 5" />
        </svg>
        {t('settings.back')}
      </button>

      {SECTIONS.map((id) => {
        const active = id === section;
        return (
          <button
            key={id}
            type="button"
            aria-current={active ? 'page' : undefined}
            onClick={() => setSection(id)}
            className={`pressable relative flex items-center gap-2.5 rounded-ctl px-2.5 py-2 text-left text-[12.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60 ${
              active
                ? 'font-medium text-accent'
                : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
            }`}
          >
            {/* The chosen section's wash is one object that slides between
                rows — the same pane the rail's selection uses, with the rule
                riding its left edge — so a switch reads as the mark moving
                rather than as one background blinking off and another on. */}
            {active && (
              <motion.span
                layoutId="settings-section-pane"
                transition={SPRING_GLIDE}
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 rounded-ctl bg-accent-muted"
              >
                <span className="absolute -left-2.5 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
              </motion.span>
            )}
            <span className={`relative ${active ? 'text-accent' : 'text-text-muted'}`}>
              {SECTION_ICONS[id]}
            </span>
            <span className="relative truncate">{sectionLabel(id)}</span>
          </button>
        );
      })}

      <div className="mt-auto px-2 pt-3 font-mono text-xs tabular-nums text-text-muted">
        v{__APP_VERSION__}
      </div>
    </nav>
  );
}
