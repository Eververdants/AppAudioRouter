import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { ConfirmButton } from '@/components/ui/ConfirmButton';
import { DelayStepper } from '@/components/ui/DelayStepper';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { useTheme } from '@/hooks/useTheme';
import { useLanguage } from '@/hooks/useLanguage';
import { detectCarrierPair, matchesCarrier } from '@/lib/carrierDetect';
import { DELAY_RANGE_OPTIONS, DELAY_STEP_OPTIONS, formatStep, rangeSeconds } from '@/lib/delay';
import { isEditableTarget } from '@/lib/productionGuards';
import { openCarrierDownload } from '@/lib/invoke';
import { FADE, MAIN_THREAD_TRANSFORM, SPRING_GLIDE } from '@/lib/motion';
import type { AudioDevice, AudioSession, RememberedRouteEntry } from '@/lib/types';
import { useRouterStore } from '@/stores/routerStore';

/**
 * The settings-row button: the same shape as `ConfirmButton`'s pill, minus the
 * asking. Kept beside the components that use it so the two never drift into
 * looking like different kinds of control.
 */
const ROW_BUTTON_CLASS =
  'pressable shrink-0 rounded-ctl border border-line px-2.5 py-1 text-[11px] font-medium text-text-secondary outline-none hover:border-accent/50 hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-default disabled:opacity-45 disabled:hover:border-line disabled:hover:text-text-secondary';

/** One setting: what it is on the left, the control that changes it on the
 * right, and a hairline under it to separate it from the next. */
function Row({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line py-3.5 last:border-b-0">
      <div className="min-w-0">
        <div className="text-[13px] text-text-primary">{title}</div>
        {/* Capped at a reading measure: a description that runs to the width of
            the page would push the control it describes out to the far edge. */}
        {desc && (
          <div className="mt-1 max-w-[52ch] text-[11px] leading-relaxed text-text-muted">
            {desc}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

/** A stacked block: a title, an explanation, then whatever the setting owns. */
function Block({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children: ReactNode;
}) {
  return (
    <div className="border-b border-line py-3.5 last:border-b-0">
      <div className="text-[13px] text-text-primary">{title}</div>
      {desc && (
        <div className="mt-1 max-w-[52ch] text-[11px] leading-relaxed text-text-muted">
          {desc}
        </div>
      )}
      <div className="mt-3">{children}</div>
    </div>
  );
}

/** A device row: name + the shared −/value/+ delay stepper. */
function DelayRow({
  deviceId,
  name,
  rangeMs,
}: {
  deviceId: string;
  name: string;
  rangeMs: number;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-line py-2.5 last:border-b-0">
      <span className="min-w-0 flex-1 truncate text-xs text-text-secondary" title={name}>
        {name}
      </span>
      <DelayStepper deviceId={deviceId} name={name} rangeMs={rangeMs} />
    </div>
  );
}

/**
 * The executables this app is duplicating right now, one entry per program.
 *
 * Duplicating, not merely routed: a route to a single device is played by the
 * system directly and starts no engine at all, so there is no gain path for a
 * level to travel and no level to set — the same rule that decides which source
 * nodes on the routing board wear a dial. A program with no route is out for
 * the same reason.
 *
 * The level belongs to the program, not to a process — a browser is a dozen
 * PIDs all playing the same thing — so the names are deduplicated by
 * executable.
 *
 * Ordered as the session list is, which is already by executable name, so the
 * rows do not shuffle between refreshes.
 */
function duplicatedExecutables(
  sessions: AudioSession[],
  routedPids: Record<number, string[]>,
): string[] {
  const names: string[] = [];
  for (const session of sessions) {
    if ((routedPids[session.pid]?.length ?? 0) < 2) continue;
    if (!names.includes(session.exe_name)) names.push(session.exe_name);
  }
  return names;
}

/**
 * One remembered route: the executable it belongs to, and the ✕ that forgets it.
 *
 * Auto-restore is a decision the app makes on the user's behalf, so it has to be
 * revocable from the same place it is switched on — without this, un-remembering
 * a route meant editing a JSON file by hand.
 */
function RememberedChip({
  entry,
  devices,
  onForget,
}: {
  entry: RememberedRouteEntry;
  devices: AudioDevice[];
  onForget: (exeName: string) => void;
}) {
  const { t } = useTranslation();
  const label = t('settings.forgetRoute', { process: entry.exeName });
  const target = entry.deviceIds
    .map((id) => devices.find((device) => device.id === id)?.name ?? id)
    .join(' · ');
  return (
    <motion.span
      layout
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={FADE}
      transformTemplate={MAIN_THREAD_TRANSFORM}
      title={`${entry.exeName} → ${target}`}
      className="flex max-w-full items-center gap-1 rounded-seg border border-line bg-surface-raised py-0.5 pl-1.5 pr-0.5 font-mono text-[10px] text-text-secondary"
    >
      <span className="truncate">{entry.exeName}</span>
      <button
        type="button"
        onClick={() => onForget(entry.exeName)}
        aria-label={label}
        title={label}
        className="pressable flex h-4 w-4 flex-none items-center justify-center rounded-full text-text-muted outline-none hover:bg-error/10 hover:text-error focus-visible:ring-2 focus-visible:ring-error/50"
      >
        <svg
          width="8"
          height="8"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <line x1="1" y1="1" x2="9" y2="9" />
          <line x1="9" y1="1" x2="1" y2="9" />
        </svg>
      </button>
    </motion.span>
  );
}

const SunIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="5" />
    <line x1="12" y1="1" x2="12" y2="3" />
    <line x1="12" y1="21" x2="12" y2="23" />
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
    <line x1="1" y1="12" x2="3" y2="12" />
    <line x1="21" y1="12" x2="23" y2="12" />
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
  </svg>
);

const MoonIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

/** The sections the settings rail can show, in the order it lists them. */
type SettingsSection = 'appearance' | 'routing' | 'background' | 'delays' | 'levels' | 'about';

/** The rail's glyphs, one per section. Drawn once and reused by the nav. */
const SECTION_ICONS: Record<SettingsSection, ReactNode> = {
  appearance: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  ),
  routing: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  ),
  background: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v11" />
      <path d="M8 10.5 12 14.5 16 10.5" />
      <path d="M4 17.5h16" />
    </svg>
  ),
  delays: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15.5 13.5" />
    </svg>
  ),
  levels: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
      <line x1="4" y1="6" x2="20" y2="6" />
      <circle cx="9" cy="6" r="2" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <circle cx="15" cy="12" r="2" />
      <line x1="4" y1="18" x2="20" y2="18" />
      <circle cx="7" cy="18" r="2" />
    </svg>
  ),
  about: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  ),
};

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
 */
export function SettingsPage({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();
  const { language, setLanguage } = useLanguage();
  const devices = useRouterStore((s) => s.devices);
  const autoRemember = useRouterStore((s) => s.autoRemember);
  const toggleAutoRemember = useRouterStore((s) => s.toggleAutoRemember);
  const rememberedRoutes = useRouterStore((s) => s.rememberedRoutes);
  const forgetRememberedRoute = useRouterStore((s) => s.forgetRememberedRoute);
  const resetPinnedEndpoints = useRouterStore((s) => s.resetPinnedEndpoints);
  const stopAllRoutes = useRouterStore((s) => s.stopAllRoutes);
  const routedCount = useRouterStore((s) => Object.keys(s.routedPids).length);
  const delayRangeMs = useRouterStore((s) => s.delayRangeMs);
  const setDelayRange = useRouterStore((s) => s.setDelayRange);
  const delayStepMs = useRouterStore((s) => s.delayStepMs);
  const setDelayStep = useRouterStore((s) => s.setDelayStep);
  const sessions = useRouterStore((s) => s.sessions);
  const routedPids = useRouterStore((s) => s.routedPids);
  const alignSourceLevels = useRouterStore((s) => s.alignSourceLevels);
  const closeToTray = useRouterStore((s) => s.closeToTray);
  const toggleCloseToTray = useRouterStore((s) => s.toggleCloseToTray);
  const autostart = useRouterStore((s) => s.autostart);
  const toggleAutostart = useRouterStore((s) => s.toggleAutostart);
  const feedCarrier = useRouterStore((s) => s.feedCarrier);
  const setFeedCarrier = useRouterStore((s) => s.setFeedCarrier);
  const captureDevices = useRouterStore((s) => s.captureDevices);

  const [section, setSection] = useState<SettingsSection>('appearance');

  // Only ever disables one button, but it walks the whole session list, and
  // this page re-renders for every store field it reads — several of which
  // move whenever audio comes or goes.
  const duplicated = useMemo(
    () => duplicatedExecutables(sessions, routedPids),
    [sessions, routedPids],
  );
  // Which known loopback driver, if any, is on the two lists right now. Both
  // lists follow the audio-changed event, so a driver installed while the app
  // is open pairs without a restart.
  const carrierMatch = useMemo(
    () => detectCarrierPair(devices, captureDevices),
    [devices, captureDevices],
  );

  useEffect(() => {
    // Capture phase, and the key is consumed: this page is a full surface, and
    // the Escape that closes it must not also land in whatever sits underneath
    // — a route's undo offer lives one bubble-phase listener away, and spending
    // it silently as a side effect of leaving the page is the exact loss the
    // toast's own comment describes. The picker, the briefing bubble and the
    // routed capsule coordinate the same key the same way.
    const onKey = (e: KeyboardEvent) => {
      // Escape belongs to the control that has the focus first: the delay
      // stepper's field, and the carrier dropdowns — a listbox that closes
      // itself on Escape carries `data-owns-escape`, so the page stands down
      // for it rather than taking the whole surface down with it.
      if (isEditableTarget(e.target)) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onBack();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onBack]);

  const SECTIONS: SettingsSection[] = [
    'appearance',
    'routing',
    'background',
    'delays',
    'levels',
    'about',
  ];
  // Written out rather than indexed by a template string: the i18n keys are
  // type-checked, and `settings.${id}` would defeat that.
  const sectionLabel = (id: SettingsSection): string => {
    switch (id) {
      case 'appearance':
        return t('settings.appearance');
      case 'routing':
        return t('settings.routing');
      case 'background':
        return t('settings.background');
      case 'delays':
        return t('settings.delays');
      case 'levels':
        return t('settings.sourceLevels');
      case 'about':
        return t('settings.about');
    }
  };

  const carrierOptions = [
    { value: '', label: t('settings.feedCarrierNone') },
    ...devices.map((device) => ({ value: device.id, label: device.name })),
  ];
  const captureOptions = [
    { value: '', label: t('settings.feedCarrierNone') },
    ...captureDevices.map((device) => ({ value: device.id, label: device.name })),
  ];

  return (
    <div className="flex h-full min-h-0">
      {/* The rail: one section per row, the chosen one marked by a rule that
          travels rather than by a pill that blinks on and off. */}
      <nav
        aria-label={t('settings.title')}
        className="flex w-[190px] flex-none flex-col gap-0.5 border-r border-line px-2.5 py-3"
      >
        <button
          type="button"
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
                  ? 'bg-accent-muted font-medium text-accent'
                  : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'
              }`}
            >
              <span className={active ? 'text-accent' : 'text-text-muted'}>
                {SECTION_ICONS[id]}
              </span>
              <span className="truncate">{sectionLabel(id)}</span>
              {active && (
                <motion.span
                  layoutId="settings-section-rule"
                  transition={SPRING_GLIDE}
                  aria-hidden="true"
                  className="absolute -left-2.5 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent"
                />
              )}
            </button>
          );
        })}

        <div className="mt-auto px-2 pt-3 font-mono text-[10px] tabular-nums text-text-muted">
          v{__APP_VERSION__}
        </div>
      </nav>

      {/* The chosen section, on the paper. One entrance-only cross-fade keyed by
          the section, so a change of section reads as a new page arriving. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-8 py-8">
          <h1 className="mb-1 text-[17px] font-semibold tracking-tight text-text-primary">
            {sectionLabel(section)}
          </h1>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={section}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={SPRING_GLIDE}
              transformTemplate={MAIN_THREAD_TRANSFORM}
            >
              {section === 'appearance' && (
                <AppearanceSection
                  theme={theme}
                  setTheme={setTheme}
                  language={language}
                  setLanguage={setLanguage}
                />
              )}

              {section === 'routing' && (
                <>
                  <Row title={t('settings.autoRemember')} desc={t('settings.autoRememberDesc')}>
                    <Switch
                      checked={autoRemember}
                      onChange={toggleAutoRemember}
                      label={t('settings.autoRemember')}
                    />
                  </Row>
                  {rememberedRoutes.length > 0 && (
                    <Block title={t('settings.rememberedRoutes')}>
                      <div className="flex flex-wrap gap-1.5">
                        <AnimatePresence initial={false}>
                          {rememberedRoutes.map((entry) => (
                            <RememberedChip
                              key={entry.exeName}
                              entry={entry}
                              devices={devices}
                              onForget={forgetRememberedRoute}
                            />
                          ))}
                        </AnimatePresence>
                      </div>
                    </Block>
                  )}
                  <Row title={t('settings.resetEndpoints')} desc={t('settings.resetEndpointsDesc')}>
                    {/* Every per-app assignment on the machine, both data flows,
                        in one press — and it reaches programs that are not on the
                        board. The same action asks first in the process list's
                        header for the same reason, so it asks here too. */}
                    <ConfirmButton
                      label={t('settings.resetEndpointsAction')}
                      confirmLabel={t('settings.resetEndpointsConfirm')}
                      onConfirm={() => void resetPinnedEndpoints()}
                    />
                  </Row>
                  <Row title={t('settings.stopAllRoutes')} desc={t('settings.stopAllRoutesDesc')}>
                    <ConfirmButton
                      label={t('settings.stopAllRoutesAction')}
                      confirmLabel={t('settings.stopAllRoutesConfirm')}
                      onConfirm={() => void stopAllRoutes()}
                      disabled={routedCount === 0}
                    />
                  </Row>
                  {/* Sending one program's audio into another's input runs through
                      a loopback pair: the source plays to the pair's playback
                      side, the target records from its recording side. The app
                      ships no driver, so the pair is picked here; without one,
                      feeds are remembered and shown on the board, but silent. */}
                  <Block title={t('settings.feedCarrier')} desc={t('settings.feedCarrierDesc')}>
                    <div className="flex flex-col gap-2">
                      <label className="flex items-center gap-3">
                        <span className="w-[130px] flex-none text-[11px] text-text-muted">
                          {t('settings.feedCarrierRender')}
                        </span>
                        <Select
                          ariaLabel={t('settings.feedCarrierRender')}
                          title={t('settings.feedCarrierRenderHint')}
                          value={feedCarrier.render ?? ''}
                          options={carrierOptions}
                          onChange={(next) =>
                            void setFeedCarrier(next === '' ? null : next, feedCarrier.capture)
                          }
                        />
                      </label>
                      <label className="flex items-center gap-3">
                        <span className="w-[130px] flex-none text-[11px] text-text-muted">
                          {t('settings.feedCarrierCapture')}
                        </span>
                        <Select
                          ariaLabel={t('settings.feedCarrierCapture')}
                          title={t('settings.feedCarrierCaptureHint')}
                          value={feedCarrier.capture ?? ''}
                          options={captureOptions}
                          onChange={(next) =>
                            void setFeedCarrier(feedCarrier.render, next === '' ? null : next)
                          }
                        />
                      </label>
                    </div>
                    {/* The known loopback drivers announce themselves: pairing is
                        one click when one is here, and the free one is one click
                        away when none is. The button below hands a driver key to
                        the backend — the URL itself never crosses from the
                        frontend. */}
                    {carrierMatch && !matchesCarrier(carrierMatch, feedCarrier) && (
                      <div className="mt-3 flex items-center justify-between gap-3">
                        <span className="text-[11px] text-text-secondary">
                          {t('settings.feedCarrierDetected', {
                            driver: carrierMatch.driver.display,
                          })}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            void setFeedCarrier(carrierMatch.renderId, carrierMatch.captureId)
                          }
                          className="pressable shrink-0 rounded-ctl bg-accent px-2.5 py-1 text-[11px] font-medium text-accent-ink outline-none hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent/60"
                        >
                          {t('settings.feedCarrierApply')}
                        </button>
                      </div>
                    )}
                    {carrierMatch && matchesCarrier(carrierMatch, feedCarrier) && (
                      <div className="mt-3 text-[11px] text-text-muted">
                        {t('settings.feedCarrierPaired', { driver: carrierMatch.driver.display })}
                      </div>
                    )}
                    {!carrierMatch && !feedCarrier.render && !feedCarrier.capture && (
                      <div className="mt-3 flex items-center justify-between gap-3">
                        <span className="max-w-[52ch] text-[11px] leading-relaxed text-text-muted">
                          {t('settings.feedCarrierMissing')}
                        </span>
                        <button
                          type="button"
                          onClick={() => void openCarrierDownload('vb-cable')}
                          className={ROW_BUTTON_CLASS}
                        >
                          {t('settings.feedCarrierDownload')}
                        </button>
                      </div>
                    )}
                  </Block>
                </>
              )}

              {section === 'background' && (
                <>
                  <Row title={t('settings.closeToTray')} desc={t('settings.closeToTrayDesc')}>
                    <Switch
                      checked={closeToTray}
                      onChange={() => void toggleCloseToTray()}
                      label={t('settings.closeToTray')}
                    />
                  </Row>
                  <Row title={t('settings.autostart')} desc={t('settings.autostartDesc')}>
                    <Switch
                      checked={autostart}
                      onChange={() => void toggleAutostart()}
                      label={t('settings.autostart')}
                    />
                  </Row>
                </>
              )}

              {section === 'delays' && (
                <>
                  <Row title={t('settings.delayRange')} desc={t('settings.delayRangeDesc')}>
                    <SegmentedControl
                      layoutId="settings-delay-range"
                      ariaLabel={t('settings.delayRange')}
                      value={String(delayRangeMs)}
                      onChange={(value) => void setDelayRange(Number(value))}
                      options={DELAY_RANGE_OPTIONS.map((ms) => ({
                        value: String(ms),
                        label: `±${rangeSeconds(ms)}s`,
                      }))}
                    />
                  </Row>
                  <Row title={t('settings.delayStep')} desc={t('settings.delayStepDesc')}>
                    <SegmentedControl
                      layoutId="settings-delay-step"
                      ariaLabel={t('settings.delayStep')}
                      value={String(delayStepMs)}
                      onChange={(value) => void setDelayStep(Number(value))}
                      options={DELAY_STEP_OPTIONS.map((ms) => ({
                        value: String(ms),
                        label: formatStep(ms),
                      }))}
                    />
                  </Row>
                  <p className="border-b border-line py-3 text-[11px] leading-relaxed text-text-muted">
                    {t('settings.delayNote')}
                  </p>
                  <p className="border-b border-line py-3 text-[11px] leading-relaxed text-text-muted">
                    {t('settings.calibrationNote')}
                  </p>
                  {devices.length === 0 ? (
                    <p className="py-6 text-center text-[11px] text-text-muted">
                      {t('settings.noDevices')}
                    </p>
                  ) : (
                    devices.map((device) => (
                      <DelayRow
                        key={device.id}
                        deviceId={device.id}
                        name={device.name}
                        rangeMs={delayRangeMs}
                      />
                    ))
                  )}
                </>
              )}

              {section === 'levels' && (
                <>
                  {/* One click and no confirmation: evening the levels out is the
                      feature, and what it covered is reported in the log rather
                      than in a question asked before it runs. */}
                  <Row
                    title={t('settings.sourceLevelsAlign')}
                    desc={t('settings.sourceLevelsAlignDesc')}
                  >
                    <button
                      type="button"
                      onClick={() => void alignSourceLevels()}
                      disabled={duplicated.length === 0}
                      className={ROW_BUTTON_CLASS}
                    >
                      {t('settings.sourceLevelsAlignAction')}
                    </button>
                  </Row>
                  {/* The levels themselves live on the board, as the ring each
                      duplicated program's source node wears — a value in the
                      context it acts in, not a second list here saying the same
                      thing twice. */}
                  <p className="py-3 text-[11px] leading-relaxed text-text-muted">
                    {t('settings.sourceLevelsNote')}
                  </p>
                </>
              )}

              {section === 'about' && (
                <div className="py-3">
                  <div className="mb-1 flex items-center justify-between gap-4">
                    <span className="text-[13px] font-medium text-text-primary">
                      App Audio Router
                    </span>
                    {/* The version is a fact, not an achievement: set in the same
                        monospaced muted type as every other number in the app. */}
                    <span className="font-mono text-[10px] tabular-nums text-text-muted">
                      v{__APP_VERSION__}
                    </span>
                  </div>
                  <p className="max-w-[52ch] text-[11px] leading-relaxed text-text-muted">
                    {t('settings.aboutDesc')}
                  </p>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

/** Theme and language, as the page's first section. */
function AppearanceSection({
  theme,
  setTheme,
  language,
  setLanguage,
}: {
  theme: 'light' | 'dark';
  setTheme: (theme: 'light' | 'dark') => void;
  language: 'zh-CN' | 'en';
  setLanguage: (language: 'zh-CN' | 'en') => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Row title={t('settings.theme')}>
        <SegmentedControl
          layoutId="settings-theme-pill"
          ariaLabel={t('settings.theme')}
          value={theme}
          onChange={setTheme}
          options={[
            {
              value: 'light',
              label: (
                <span className="flex items-center gap-1">
                  {SunIcon}
                  {t('settings.themeLight')}
                </span>
              ),
              ariaLabel: t('settings.themeLight'),
            },
            {
              value: 'dark',
              label: (
                <span className="flex items-center gap-1">
                  {MoonIcon}
                  {t('settings.themeDark')}
                </span>
              ),
              ariaLabel: t('settings.themeDark'),
            },
          ]}
        />
      </Row>
      <Row title={t('settings.language')}>
        <SegmentedControl
          layoutId="settings-language-pill"
          ariaLabel={t('settings.language')}
          value={language}
          onChange={setLanguage}
          options={[
            { value: 'zh-CN', label: '中文' },
            { value: 'en', label: 'EN' },
          ]}
        />
      </Row>
    </>
  );
}