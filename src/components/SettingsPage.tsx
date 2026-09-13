import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Switch } from '@/components/ui/Switch';
import { useTheme } from '@/hooks/useTheme';
import { useLanguage } from '@/hooks/useLanguage';
import { DELAY_PRESETS, useRouterStore } from '@/stores/routerStore';

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

/** A device row: name + preset-snapped slider + live value. */
function DelayRow({ deviceId, name }: { deviceId: string; name: string }) {
  const deviceDelays = useRouterStore((s) => s.deviceDelays);
  const setDeviceDelayValue = useRouterStore((s) => s.setDeviceDelayValue);
  // Dragging fires continuously; only commit (persist + notify the engine) on
  // release so the backend and the log are not spammed mid-drag.
  const [pending, setPending] = useState<Record<string, number>>({});

  const committed = deviceDelays[deviceId] ?? 0;
  const value = pending[deviceId] ?? committed;
  const currentIndex = DELAY_PRESETS.indexOf(value);
  const presetIndex = currentIndex >= 0 ? currentIndex : 0;
  const fillPercent = (presetIndex / (DELAY_PRESETS.length - 1)) * 100;

  const commit = () => {
    const next = pending[deviceId];
    if (next === undefined) return;
    setPending((prev) => {
      const rest = { ...prev };
      delete rest[deviceId];
      return rest;
    });
    void setDeviceDelayValue(deviceId, next);
  };

  return (
    <div className="flex items-center gap-4 rounded-xl px-3 py-2.5 transition-colors hover:bg-bg-tertiary/40">
      <span className="min-w-0 flex-1 truncate text-xs text-text-secondary" title={name}>
        {name}
      </span>
      <input
        type="range"
        min={0}
        max={DELAY_PRESETS.length - 1}
        step={1}
        value={presetIndex}
        onChange={(e) => {
          const preset = DELAY_PRESETS[Number(e.target.value)] ?? 0;
          setPending((prev) => ({ ...prev, [deviceId]: preset }));
        }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        aria-label={name}
        className="h-1 w-40 flex-none"
        style={{
          background: `linear-gradient(to right, var(--accent) ${fillPercent}%, var(--border) ${fillPercent}%)`,
        }}
      />
      <span
        className={`w-14 flex-none text-right text-xs tabular-nums ${
          value > 0 ? 'font-semibold text-accent' : 'text-text-muted'
        }`}
      >
        {value} ms
      </span>
    </div>
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
  const delaySync = useRouterStore((s) => s.delaySync);
  const toggleDelaySync = useRouterStore((s) => s.toggleDelaySync);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
            transition={{ type: 'spring', stiffness: 450, damping: 26 }}
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
            <Row title={t('settings.delaySync')} desc={t('settings.delaySyncDesc')}>
              <Switch
                checked={delaySync}
                onChange={() => void toggleDelaySync()}
                label={t('settings.delaySync')}
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
              >
                <circle cx="12" cy="12" r="9" />
                <polyline points="12 7 12 12 15.5 13.5" />
              </svg>
            }
            label={t('settings.delays')}
          >
            <p className="px-3 pb-2 pt-1 text-[11px] leading-relaxed text-text-muted">
              {t('settings.delayPrimaryNote')}
            </p>
            {devices.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-text-muted">
                {t('settings.noDevices')}
              </p>
            ) : (
              devices.map((device) => (
                <DelayRow key={device.id} deviceId={device.id} name={device.name} />
              ))
            )}
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
                  v2.0.0
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
