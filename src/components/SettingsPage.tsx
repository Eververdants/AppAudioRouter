import { useEffect, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { ConfirmButton } from '@/components/ui/ConfirmButton';
import { DelayStepper } from '@/components/ui/DelayStepper';
import { ScrubReadout } from '@/components/ui/ScrubReadout';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Switch } from '@/components/ui/Switch';
import { useTheme } from '@/hooks/useTheme';
import { useLanguage } from '@/hooks/useLanguage';
import { DELAY_RANGE_OPTIONS, DELAY_STEP_OPTIONS, formatStep, rangeSeconds } from '@/lib/delay';
import { SPRING_TAP } from '@/lib/motion';
import type { AudioDevice, AudioSession, RememberedRouteEntry } from '@/lib/types';
import { useRouterStore } from '@/stores/routerStore';

/** Top of the per-program level range, matching the engine's own ceiling. */
const SOURCE_LEVEL_MAX = 400;
/** The level that leaves a program's audio exactly as the program produced it —
 * the middle of this range, not the top of it. */
const SOURCE_LEVEL_NEUTRAL = 100;
/** One notch of the level, and the pointer travel that amounts to it. */
const SOURCE_LEVEL_STEP = 5;
const SOURCE_LEVEL_PX_PER_STEP = 3;

const cardEnter = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
} as const;

function SectionCard({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-glass bg-glass-strong shadow-glass backdrop-blur-xl">
      <h3 className="flex items-center gap-2 px-5 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-widest text-text-muted">
        <span className="text-accent">{icon}</span>
        {label}
      </h3>
      <div className="space-y-0.5 p-2 pt-1">{children}</div>
    </section>
  );
}

function Row({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl px-3 py-3 transition-colors hover:bg-bg-tertiary/40">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-text-primary">{title}</div>
        {desc && <div className="mt-0.5 text-[11px] leading-relaxed text-text-muted">{desc}</div>}
      </div>
      {children}
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
    <div className="flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-bg-tertiary/40">
      <span className="min-w-0 flex-1 truncate text-xs text-text-secondary" title={name}>
        {name}
      </span>
      <DelayStepper deviceId={deviceId} name={name} rangeMs={rangeMs} />
    </div>
  );
}

/** One routed program's level: its executable name, and the shared scrubbable
 * readout next to it. */
function SourceLevelRow({ exeName }: { exeName: string }) {
  const { t } = useTranslation();
  const committed = useRouterStore((s) => s.sourceVolumes[exeName] ?? SOURCE_LEVEL_NEUTRAL);
  const setSourceVolume = useRouterStore((s) => s.setSourceVolume);

  return (
    <div className="flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-bg-tertiary/40">
      <span className="min-w-0 flex-1 truncate text-xs text-text-secondary" title={exeName}>
        {exeName}
      </span>
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
        onCommit={(next) => void setSourceVolume(exeName, next)}
      />
    </div>
  );
}

/**
 * The executables this app is duplicating right now, one entry per program.
 *
 * Duplicating, not merely routed: a route to a single device is played by the
 * system directly and starts no engine at all, so there is no gain path for a
 * level to travel and setting one would do nothing. Listing such a program with
 * a live readout beside it would claim otherwise, which is the same lie the
 * device annotations refuse to tell.
 *
 * The level belongs to the program, not to a process — a browser is a dozen
 * PIDs all playing the same thing — so the rows are deduplicated by executable
 * name. A program with no route is out for the same reason as the single-device
 * one: no engine, so no level to set.
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
    <span
      title={`${entry.exeName} → ${target}`}
      className="flex max-w-full items-center gap-1 rounded-full border border-glass bg-glass px-2 py-0.5 text-[11px] text-text-secondary"
    >
      <span className="truncate">{entry.exeName}</span>
      <button
        type="button"
        onClick={() => onForget(entry.exeName)}
        aria-label={label}
        title={label}
        className="-mr-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full text-text-muted outline-none transition-colors hover:bg-error/10 hover:text-error focus-visible:ring-2 focus-visible:ring-error/50"
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
    </span>
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

/**
 * Settings as a full page (not a modal): slides in over the content area from
 * the title-bar gear and slides back out. Owns everything app-level — theme,
 * language, auto-remember, latency sync and the per-device delay sliders.
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
  const delaySync = useRouterStore((s) => s.delaySync);
  const toggleDelaySync = useRouterStore((s) => s.toggleDelaySync);
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
  const duplicated = duplicatedExecutables(sessions, routedPids);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't close settings when Escape is pressed inside an input (e.g. delay stepper).
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'Escape') onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-5 px-4 pb-8 pt-6">
        {/* Page header */}
        <div>
          <motion.button
            type="button"
            onClick={onBack}
            whileHover={{ x: -3 }}
            whileTap={{ scale: 0.96 }}
            transition={SPRING_TAP}
            className="flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium text-text-secondary outline-none transition-colors hover:bg-bg-tertiary/60 hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <svg
              width="13"
              height="13"
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
          </motion.button>
          <h1 className="mt-2 px-2 text-lg font-semibold text-text-primary">
            {t('settings.title')}
          </h1>
        </div>

        <motion.div {...cardEnter} transition={{ duration: 0.2, ease: 'easeOut', delay: 0.04 }}>
          <SectionCard
            icon={
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
              </svg>
            }
            label={t('settings.appearance')}
          >
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
          </SectionCard>
        </motion.div>

        <motion.div {...cardEnter} transition={{ duration: 0.2, ease: 'easeOut', delay: 0.08 }}>
          <SectionCard
            icon={
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
            }
            label={t('settings.routing')}
          >
            <Row title={t('settings.autoRemember')} desc={t('settings.autoRememberDesc')}>
              <Switch
                checked={autoRemember}
                onChange={toggleAutoRemember}
                label={t('settings.autoRemember')}
              />
            </Row>
            {rememberedRoutes.length > 0 && (
              <div className="px-3 pb-3 pt-1">
                <div className="mb-1.5 text-[11px] text-text-muted">
                  {t('settings.rememberedRoutes')}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {rememberedRoutes.map((entry) => (
                    <RememberedChip
                      key={entry.exeName}
                      entry={entry}
                      devices={devices}
                      onForget={forgetRememberedRoute}
                    />
                  ))}
                </div>
              </div>
            )}
            <Row title={t('settings.delaySync')} desc={t('settings.delaySyncDesc')}>
              <Switch
                checked={delaySync}
                onChange={() => void toggleDelaySync()}
                label={t('settings.delaySync')}
              />
            </Row>
            <Row title={t('settings.resetEndpoints')} desc={t('settings.resetEndpointsDesc')}>
              <button
                type="button"
                onClick={() => void resetPinnedEndpoints()}
                className="shrink-0 rounded-full border border-glass bg-glass px-3 py-1.5 text-[11px] font-medium text-text-secondary outline-none transition-colors hover:border-accent/40 hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                {t('settings.resetEndpointsAction')}
              </button>
            </Row>
            {/* The same action as the process list header, and the same reason it
                asks first: it reaches every routed program, not just the one the
                user has in mind. */}
            <Row title={t('settings.stopAllRoutes')} desc={t('settings.stopAllRoutesDesc')}>
              <ConfirmButton
                label={t('settings.stopAllRoutesAction')}
                confirmLabel={t('settings.stopAllRoutesConfirm')}
                onConfirm={() => void stopAllRoutes()}
                disabled={routedCount === 0}
              />
            </Row>
          </SectionCard>
        </motion.div>

        <motion.div {...cardEnter} transition={{ duration: 0.2, ease: 'easeOut', delay: 0.12 }}>
          <SectionCard
            icon={
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 3v11" />
                <path d="M8 10.5 12 14.5 16 10.5" />
                <path d="M4 17.5h16" />
              </svg>
            }
            label={t('settings.background')}
          >
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
          </SectionCard>
        </motion.div>

        <motion.div {...cardEnter} transition={{ duration: 0.2, ease: 'easeOut', delay: 0.16 }}>
          <SectionCard
            icon={
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="9" />
                <polyline points="12 7 12 12 15.5 13.5" />
              </svg>
            }
            label={t('settings.delays')}
          >
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
                onChange={(value) => setDelayStep(Number(value))}
                options={DELAY_STEP_OPTIONS.map((ms) => ({
                  value: String(ms),
                  label: formatStep(ms),
                }))}
              />
            </Row>
            <p className="px-3 pb-1 pt-2 text-[11px] leading-relaxed text-text-muted">
              {t('settings.delayNote')}
            </p>
            {devices.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-text-muted">
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
          </SectionCard>
        </motion.div>

        <motion.div {...cardEnter} transition={{ duration: 0.2, ease: 'easeOut', delay: 0.2 }}>
          <SectionCard
            icon={
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <line x1="4" y1="6" x2="20" y2="6" />
                <circle cx="9" cy="6" r="2" />
                <line x1="4" y1="12" x2="20" y2="12" />
                <circle cx="15" cy="12" r="2" />
                <line x1="4" y1="18" x2="20" y2="18" />
                <circle cx="7" cy="18" r="2" />
              </svg>
            }
            label={t('settings.sourceLevels')}
          >
            {/* One click and no confirmation: evening the levels out is the
                feature, and what it covered is reported in the log rather than
                in a question asked before it runs. */}
            <Row title={t('settings.sourceLevelsAlign')} desc={t('settings.sourceLevelsAlignDesc')}>
              <button
                type="button"
                onClick={() => void alignSourceLevels()}
                disabled={duplicated.length === 0}
                className="shrink-0 rounded-full border border-glass bg-glass px-3 py-1.5 text-[11px] font-medium text-text-secondary outline-none transition-colors hover:border-accent/40 hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-default disabled:opacity-45 disabled:hover:border-glass disabled:hover:text-text-secondary"
              >
                {t('settings.sourceLevelsAlignAction')}
              </button>
            </Row>
            <p className="px-3 pb-1 pt-2 text-[11px] leading-relaxed text-text-muted">
              {t('settings.sourceLevelsNote')}
            </p>
            {duplicated.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-text-muted">
                {t('settings.sourceLevelsNone')}
              </p>
            ) : (
              duplicated.map((exeName) => <SourceLevelRow key={exeName} exeName={exeName} />)
            )}
          </SectionCard>
        </motion.div>

        <motion.div {...cardEnter} transition={{ duration: 0.2, ease: 'easeOut', delay: 0.24 }}>
          <SectionCard
            icon={
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 16v-4M12 8h.01" />
              </svg>
            }
            label={t('settings.about')}
          >
            <div className="px-3 py-2.5">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[13px] font-semibold text-text-primary">
                  App Audio Router
                </span>
                <span className="rounded-full bg-accent-muted px-2 py-0.5 text-[10px] font-medium text-accent">
                  v{__APP_VERSION__}
                </span>
              </div>
              <p className="text-[11px] leading-relaxed text-text-muted">
                {t('settings.aboutDesc')}
              </p>
            </div>
          </SectionCard>
        </motion.div>
      </div>
    </div>
  );
}
