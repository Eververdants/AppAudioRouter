import { useEffect, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmButton } from '@/components/ui/ConfirmButton';
import { DelayStepper } from '@/components/ui/DelayStepper';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Switch } from '@/components/ui/Switch';
import { useTheme } from '@/hooks/useTheme';
import { useLanguage } from '@/hooks/useLanguage';
import { detectCarrierPair, matchesCarrier } from '@/lib/carrierDetect';
import { DELAY_RANGE_OPTIONS, DELAY_STEP_OPTIONS, formatStep, rangeSeconds } from '@/lib/delay';
import { openCarrierDownload } from '@/lib/invoke';
import type { AudioDevice, AudioSession, RememberedRouteEntry } from '@/lib/types';
import { useRouterStore } from '@/stores/routerStore';

/**
 * The settings-row button: the same shape as `ConfirmButton`'s pill, minus the
 * asking. Kept beside the components that use it so the two never drift into
 * looking like different kinds of control.
 */
const ROW_BUTTON_CLASS =
  'shrink-0 rounded border border-line px-2.5 py-1 text-[11px] font-medium text-text-secondary outline-none transition-colors hover:border-accent/50 hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-default disabled:opacity-45 disabled:hover:border-line disabled:hover:text-text-secondary';

/**
 * A titled group of rows.
 *
 * A rule and a small uppercase label, not a card: the settings page is one
 * column read top to bottom, and a box around each group would claim the groups
 * are separable objects rather than headings in a list. Nothing is rounded,
 * nothing is lifted, nothing is translucent.
 */
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
    <section>
      <h3 className="flex items-center gap-2 border-b border-line pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
        <span className="text-accent">{icon}</span>
        {label}
      </h3>
      {children}
    </section>
  );
}

/** One setting: what it is on the left, the control that changes it on the
 * right, and a hairline under it to separate it from the next. */
function Row({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="text-[13px] text-text-primary">{title}</div>
        {/* Capped at a reading measure: a description that runs to the width of
            the page would push the control it describes out to the far edge. */}
        {desc && (
          <div className="mt-0.5 max-w-[52ch] text-[11px] leading-relaxed text-text-muted">
            {desc}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

/** A device row: name + the shared −/value/+ delay stepper. */
function DelayRow({ deviceId, name, rangeMs }: { deviceId: string; name: string; rangeMs: number }) {
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
    <span
      title={`${entry.exeName} → ${target}`}
      className="flex max-w-full items-center gap-1 rounded border border-line bg-surface-raised py-0.5 pl-1.5 pr-0.5 font-mono text-[10px] text-text-secondary"
    >
      <span className="truncate">{entry.exeName}</span>
      <button
        type="button"
        onClick={() => onForget(entry.exeName)}
        aria-label={label}
        title={label}
        className="flex h-4 w-4 flex-none items-center justify-center rounded text-text-muted outline-none transition-colors hover:bg-error/10 hover:text-error focus-visible:ring-2 focus-visible:ring-error/50"
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
 * language, the advanced-controls switch, auto-remember and the per-device
 * delay sliders.
 *
 * One column, read top to bottom: a heading, then its rows, then a rule and the
 * next heading. No card, no shadow, no blur — the sections are the page itself.
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
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-9 px-8 pb-14 pt-8">
        {/* Page header: the way back, then the name of the page. */}
        <header className="border-b border-line pb-4">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1.5 rounded text-[11px] font-medium text-text-muted outline-none transition-colors hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent/60"
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
          <h1 className="mt-3 text-[17px] font-semibold tracking-tight text-text-primary">
            {t('settings.title')}
          </h1>
        </header>

        <SectionCard
          icon={
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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

        <SectionCard
          icon={
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
            <div className="border-b border-line py-3">
              <div className="mb-2 text-[11px] text-text-muted">
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
          <Row title={t('settings.resetEndpoints')} desc={t('settings.resetEndpointsDesc')}>
            <button
              type="button"
              onClick={() => void resetPinnedEndpoints()}
              className={ROW_BUTTON_CLASS}
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
          {/* Sending one program's audio into another's input runs through a
              loopback pair: the source plays to the pair's playback side, the
              target records from its recording side. The app ships no driver,
              so the pair is picked here; without one, feeds are remembered and
              shown on the board, but silent. */}
          <div className="border-b border-line py-3">
            <div className="text-[13px] text-text-primary">{t('settings.feedCarrier')}</div>
            <div className="mt-0.5 max-w-[52ch] text-[11px] leading-relaxed text-text-muted">
              {t('settings.feedCarrierDesc')}
            </div>
            <div className="mt-2.5 flex flex-col gap-2">
              <label className="flex items-center gap-3">
                <span className="w-[130px] flex-none text-[11px] text-text-muted">
                  {t('settings.feedCarrierRender')}
                </span>
                <select
                  aria-label={t('settings.feedCarrierRender')}
                  title={t('settings.feedCarrierRenderHint')}
                  value={feedCarrier.render ?? ''}
                  onChange={(event) =>
                    void setFeedCarrier(
                      event.target.value === '' ? null : event.target.value,
                      feedCarrier.capture,
                    )
                  }
                  className="min-w-0 flex-1 rounded-ctl border border-line-strong bg-surface px-2.5 py-1.5 text-[12px] text-text-secondary outline-none focus-visible:border-accent"
                >
                  <option value="">{t('settings.feedCarrierNone')}</option>
                  {devices.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-3">
                <span className="w-[130px] flex-none text-[11px] text-text-muted">
                  {t('settings.feedCarrierCapture')}
                </span>
                <select
                  aria-label={t('settings.feedCarrierCapture')}
                  title={t('settings.feedCarrierCaptureHint')}
                  value={feedCarrier.capture ?? ''}
                  onChange={(event) =>
                    void setFeedCarrier(
                      feedCarrier.render,
                      event.target.value === '' ? null : event.target.value,
                    )
                  }
                  className="min-w-0 flex-1 rounded-ctl border border-line-strong bg-surface px-2.5 py-1.5 text-[12px] text-text-secondary outline-none focus-visible:border-accent"
                >
                  <option value="">{t('settings.feedCarrierNone')}</option>
                  {captureDevices.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {/* The known loopback drivers announce themselves: pairing is one
                click when one is here, and the free one is one click away when
                none is. The button below hands a driver key to the backend —
                the URL itself never crosses from the frontend. */}
            {carrierMatch && !matchesCarrier(carrierMatch, feedCarrier) && (
              <div className="mt-2.5 flex items-center justify-between gap-3">
                <span className="text-[11px] text-text-secondary">
                  {t('settings.feedCarrierDetected', { driver: carrierMatch.driver.display })}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    void setFeedCarrier(carrierMatch.renderId, carrierMatch.captureId)
                  }
                  className="shrink-0 rounded bg-accent px-2.5 py-1 text-[11px] font-medium text-accent-ink outline-none transition-colors hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent/60"
                >
                  {t('settings.feedCarrierApply')}
                </button>
              </div>
            )}
            {carrierMatch && matchesCarrier(carrierMatch, feedCarrier) && (
              <div className="mt-2.5 text-[11px] text-text-muted">
                {t('settings.feedCarrierPaired', { driver: carrierMatch.driver.display })}
              </div>
            )}
            {!carrierMatch && !feedCarrier.render && !feedCarrier.capture && (
              <div className="mt-2.5 flex items-center justify-between gap-3">
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
          </div>
        </SectionCard>

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

        <SectionCard
          icon={
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
        </SectionCard>

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
              className={ROW_BUTTON_CLASS}
            >
              {t('settings.sourceLevelsAlignAction')}
            </button>
          </Row>
          {/* The levels themselves live on the board, as the ring each
              duplicated program's source node wears — a value in the context it
              acts in, not a second list here saying the same thing twice. */}
          <p className="py-3 text-[11px] leading-relaxed text-text-muted">
            {t('settings.sourceLevelsNote')}
          </p>
        </SectionCard>

        <SectionCard
          icon={
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 16v-4M12 8h.01" />
            </svg>
          }
          label={t('settings.about')}
        >
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
        </SectionCard>
      </div>
    </div>
  );
}
