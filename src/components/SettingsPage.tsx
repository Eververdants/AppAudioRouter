import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { DelayCalibration } from '@/components/DelayCalibration';
import { AboutSection } from '@/components/settings/AboutSection';
import { AppearanceSection } from '@/components/settings/AppearanceSection';
import { BackgroundSection } from '@/components/settings/BackgroundSection';
import { DelaySection } from '@/components/settings/DelaySection';
import { LevelsSection } from '@/components/settings/LevelsSection';
import { Rail, type SettingsSection } from '@/components/settings/Rail';
import { RoutingSection } from '@/components/settings/RoutingSection';
import { useSectionLabel } from '@/components/settings/hooks/useSectionLabel';
import { useLanguage } from '@/hooks/useLanguage';
import { useTheme } from '@/hooks/useTheme';
import { MAIN_THREAD_TRANSFORM, SPRING_GLIDE } from '@/lib/motion';
import { isEditableTarget } from '@/lib/productionGuards';
import { useRouterStore } from '@/stores/routerStore';

/**
 * Settings as a full page (not a modal): slides in over the content area from
 * the title-bar gear and slides back out.
 *
 * Laid out the way a settings surface is read: a rail of sections down the left
 * and the chosen section's rows filling the right. The old single column grew
 * with every addition — one long scroll where appearance, routing, delays and
 * the about box all competed for the same attention — and a rail gives each
 * group of decisions its own place without a card around any of them. The page
 * itself is still one flat paper: a rail, a hairline, and rows.
 *
 * What stays in this file is the page's own choreography: which section is
 * showing, the one entrance-only arrival that carries it in, the Escape that
 * closes the page (and stands down for whatever has the focus), and the delay
 * wizard that floats above the paper with the button that opened it as its
 * landing spot for the keyboard. `settings/*` holds the line shapes (`Row`,
 * `Block`, `DelayRow`, `RememberedChip`), the rail, the six sections, and the
 * two facts the sections ask about — which programs are duplicating, and what
 * each section is called. A section reads the store fields only it uses; the
 * device list arrives as a prop because this page needs it too, for the wizard.
 */
export function SettingsPage({ onBack }: { onBack: () => void }) {
  const devices = useRouterStore((s) => s.devices);
  const { theme, setTheme } = useTheme();
  const { language, setLanguage } = useLanguage();
  const sectionLabel = useSectionLabel();

  const [section, setSection] = useState<SettingsSection>('appearance');
  // The delay wizard; mounted over the page while it runs. The button keeps a
  // ref because the wizard takes the keyboard when it closes: the caret goes
  // back to the control that opened it, not to the top of the window.
  const [calibrationOpen, setCalibrationOpen] = useState(false);
  const calibrateButtonRef = useRef<HTMLButtonElement | null>(null);
  // The page's own exit, kept as the fallback landing spot for a keyboard that
  // has just been turned out of a dialog whose opener can no longer take it.
  const backRef = useRef<HTMLButtonElement | null>(null);
  // The section that is already on the paper when the page opens lands in
  // place; only a *change* of section plays the arrival. A ref rather than
  // state: it is read on the section's own mount, so it has to be a value that
  // flips after the first render without causing one of its own.
  const firstSection = useRef(true);
  useEffect(() => {
    firstSection.current = false;
  }, []);

  // The wizard is mounted outside the section column (it is an overlay, not a
  // row), so switching away from 「延迟补偿」 does not unmount it on its own: a
  // measurement would keep playing short tones over a page that no longer shows
  // them. Closing it here is the stop — the wizard's own unmount cancels a live
  // run — and it resets for the same reason the section state does: the page
  // records the start of a visit, not where the user parked.
  useEffect(() => {
    if (section !== 'delays') setCalibrationOpen(false);
  }, [section]);

  useEffect(() => {
    // Capture phase, and the key is consumed: this page is a full surface, and
    // the Escape that closes it must not also land in whatever sits underneath
    // — a route's undo offer lives one bubble-phase listener away, and spending
    // it silently as a side effect of leaving the page is the exact loss the
    // toast's own comment describes. The stage's pickers and the routed
    // capsule coordinate the same key the same way.
    const onKey = (e: KeyboardEvent) => {
      // Escape belongs to the control that has the focus first: the delay
      // stepper's field, the carrier dropdowns — a listbox that closes
      // itself on Escape carries `data-owns-escape`, so the page stands down
      // for it rather than taking the whole surface down with it. The delay
      // wizard owns the key for its whole open life, the same bargain.
      if (calibrationOpen || isEditableTarget(e.target)) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onBack();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onBack, calibrationOpen]);

  return (
    <div className="flex h-full min-h-0">
      {/* The rail: one section per row, the chosen one marked by a rule that
          travels rather than by a pill that blinks on and off. */}
      <Rail section={section} setSection={setSection} onBack={onBack} backRef={backRef} />

      {/* The chosen section, on the paper. One entrance-only arrival keyed by
          the section, so a change of section reads as a new page arriving — and
          no exit: the outgoing section unmounts at once, the way the top-level
          view swap does. ⚠️ Do not wrap this in `AnimatePresence mode="wait"`:
          the theme/language rule is a `layoutId` element, and while one animates
          inside the outgoing section the exit never reports complete, so
          `mode="wait"` holds the next section back forever (choosing a theme or
          language and then changing section left the paper blank). */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-8 py-8">
          <motion.div
            key={section}
            initial={firstSection.current ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={SPRING_GLIDE}
            transformTemplate={MAIN_THREAD_TRANSFORM}
          >
            {/* The heading rides the same arrival as its rows: a title that
                snaps while the content beneath it eases in reads as two
                half-animations, not as one page change. */}
            <h1 className="mb-1 text-[17px] font-semibold tracking-tight text-text-primary">
              {sectionLabel(section)}
            </h1>
            {section === 'appearance' && (
              <AppearanceSection
                theme={theme}
                setTheme={setTheme}
                language={language}
                setLanguage={setLanguage}
              />
            )}

            {section === 'routing' && <RoutingSection devices={devices} />}

            {section === 'background' && <BackgroundSection />}

            {section === 'delays' && (
              <DelaySection
                devices={devices}
                setCalibrationOpen={setCalibrationOpen}
                calibrateButtonRef={calibrateButtonRef}
              />
            )}

            {section === 'levels' && <LevelsSection />}

            {section === 'about' && <AboutSection language={language} />}
          </motion.div>
        </div>
      </div>

      {/* The delay wizard reads devices that are already on the page; it sits
          above the paper like every other surface does. */}
      {calibrationOpen && (
        <DelayCalibration
          devices={devices}
          onClose={() => {
            setCalibrationOpen(false);
            // The key goes back to the button that opened the dialog — unless
            // that button has since been switched off (both devices left while
            // the wizard was up, and its own gate is `devices.length < 2`):
            // `focus()` on a disabled control does nothing, and the caret would
            // be left at the document root, where the next Tab starts the whole
            // window over again. The back button is always there and always able.
            const opener = calibrateButtonRef.current;
            if (opener !== null && !opener.disabled) opener.focus();
            else backRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}
