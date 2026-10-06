import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Switch } from '@/components/ui/Switch';
import { detectCarrierPair, matchesCarrier, type CarrierMatch } from '@/lib/carrierDetect';
import { openCarrierDownload } from '@/lib/invoke';
import { FADE } from '@/lib/motion';
import type { FeedCarrier } from '@/lib/types';
import { useRouterStore } from '@/stores/routerStore';

/** The four stops of the tour, in the order a new user needs them. */
const STEPS = 4;

/**
 * The first run, full-screen. Every earlier version's welcome was two lines in
 * a dialog; this one walks the four things a new user actually needs — what the
 * app is, how the board reads, what feeding another program's input requires,
 * and the two background habits — and gets out of the way.
 *
 * It is a page, not an overlay: it replaces the work area for as long as the
 * un-acknowledged first-run notice stands, so the title bar (and its window
 * controls) stay live. Done, skip, and Escape all acknowledge the notice
 * through the same path the old dialog used, which is what makes this a
 * once-per-version event and never a nag.
 *
 * The carrier step is the reason the tour exists: routing to devices works
 * with nothing installed, but feeding a program's input needs a loopback
 * driver's endpoint pair, and this is the one moment the app can explain that
 * and pair (or fetch) the pair before the user ever wonders why a feed card
 * says 未接通.
 */
export function StartupWizard() {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const dismiss = useRouterStore((s) => s.dismissStartupNotice);
  const devices = useRouterStore((s) => s.devices);
  const captureDevices = useRouterStore((s) => s.captureDevices);
  const feedCarrier = useRouterStore((s) => s.feedCarrier);
  const setFeedCarrier = useRouterStore((s) => s.setFeedCarrier);
  const autostart = useRouterStore((s) => s.autostart);
  const toggleAutostart = useRouterStore((s) => s.toggleAutostart);
  const closeToTray = useRouterStore((s) => s.closeToTray);
  const toggleCloseToTray = useRouterStore((s) => s.toggleCloseToTray);

  const carrierMatch = useMemo(
    () => detectCarrierPair(devices, captureDevices),
    [devices, captureDevices],
  );

  // Escape leaves the tour exactly the way the skip link does. The listener
  // lives only while the wizard does — the app's Escape paths never overlap.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void dismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismiss]);

  const last = step === STEPS - 1;

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center px-8">
      <div className="flex w-full max-w-xl flex-col">
        <motion.div
          key={step}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={FADE}
        >
          {step === 0 && <WelcomeStep />}
          {step === 1 && <BoardStep />}
          {step === 2 && (
            <CarrierStep
              carrierMatch={carrierMatch}
              feedCarrier={feedCarrier}
              onPair={() => {
                if (carrierMatch) {
                  void setFeedCarrier(carrierMatch.renderId, carrierMatch.captureId);
                }
              }}
            />
          )}
          {step === 3 && (
            <BackgroundStep
              autostart={autostart}
              onAutostart={() => void toggleAutostart()}
              closeToTray={closeToTray}
              onCloseToTray={() => void toggleCloseToTray()}
            />
          )}
        </motion.div>

        {/* Step dots are the only progress furniture the tour carries: four
            stops fit in a glance, so no bar, no counter. */}
        <div className="mt-12 flex items-center justify-between">
          <div className="flex items-center gap-1.5" role="group" aria-label={t('wizard.stepsLabel')}>
            {Array.from({ length: STEPS }, (_, i) => (
              <span
                key={i}
                aria-hidden="true"
                className={`h-1.5 w-1.5 rounded-full transition-colors ${
                  i === step ? 'bg-accent' : 'bg-hairline-strong'
                }`}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void dismiss()}
              className="rounded px-2.5 py-1 text-[11px] font-medium text-text-muted outline-none transition-colors hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              {t('wizard.skip')}
            </button>
            {step > 0 && (
              <button
                type="button"
                onClick={() => setStep(step - 1)}
                className="rounded border border-line px-3 py-1.5 text-[11px] font-medium text-text-secondary outline-none transition-colors hover:border-accent/50 hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                {t('wizard.back')}
              </button>
            )}
            <button
              type="button"
              autoFocus
              onClick={() => (last ? void dismiss() : setStep(step + 1))}
              className="rounded bg-accent px-4 py-1.5 text-[11px] font-medium text-accent-ink outline-none transition-colors hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              {last ? t('wizard.start') : t('wizard.next')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The heading + prose every step shares: one claim, then the sentences that
 * carry it. The list bullets are plain hairline-dotted rows — the settings
 * page's vocabulary, not a new one. */
function StepText({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h1 className="text-[19px] font-semibold tracking-tight text-text-primary">{title}</h1>
      <div className="mt-3 text-[12.5px] leading-relaxed text-text-secondary">{children}</div>
    </div>
  );
}

function WelcomeStep() {
  const { t } = useTranslation();
  return (
    <StepText title={t('wizard.welcomeTitle', { product: t('productName') })}>
      <p>{t('wizard.welcomeBody')}</p>
      <ul className="mt-5 flex flex-col gap-2.5">
        {(['welcomePoint1', 'welcomePoint2', 'welcomePoint3'] as const).map((key) => (
          <li key={key} className="flex items-start gap-2.5">
            <span aria-hidden="true" className="mt-[7px] h-1 w-1 flex-none rounded-full bg-accent" />
            <span>{t(`wizard.${key}`)}</span>
          </li>
        ))}
      </ul>
    </StepText>
  );
}

/** A still sketch of the board's shape — hub left, numbered targets right, one
 * line to each. It teaches the reading order, nothing more: it draws no live
 * route and carries no state, which is what keeps the board the only place a
 * route is ever drawn. */
function BoardSketch() {
  const { t } = useTranslation();
  return (
    <div className="relative mt-6 h-[118px] w-[360px]" aria-hidden="true">
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 360 118">
        <line x1="152" y1="42" x2="248" y2="30" stroke="var(--text-muted)" strokeWidth="1.75" />
        <line x1="152" y1="66" x2="248" y2="84" stroke="var(--text-muted)" strokeWidth="1.75" />
      </svg>
      <div className="absolute left-0 top-[24px] flex h-[60px] w-[152px] flex-col justify-center rounded-card border border-line-strong bg-surface px-4">
        <span className="text-[12px] font-medium text-text-primary">{t('wizard.sketchHub')}</span>
        <span className="mt-0.5 text-[10px] text-text-muted">{t('wizard.sketchHubHint')}</span>
      </div>
      <div className="absolute right-0 top-[8px] flex h-[44px] w-[112px] items-center justify-between rounded-card border border-line-strong bg-surface pl-3 pr-2.5">
        <span className="text-[11px] text-text-primary">{t('wizard.sketchTargetDevice')}</span>
        <span className="flex h-[18px] w-[22px] items-center justify-center rounded-full font-mono text-[9px] tabular-nums text-[var(--type-primary)] ring-1 ring-[var(--type-primary)]">
          01
        </span>
      </div>
      <div className="absolute right-0 top-[64px] flex h-[44px] w-[112px] items-center justify-between rounded-card border border-line-strong bg-surface pl-3 pr-2.5">
        <span className="text-[11px] text-text-primary">{t('wizard.sketchTargetFeed')}</span>
        <span className="flex h-[18px] w-[22px] items-center justify-center rounded-full font-mono text-[9px] tabular-nums text-[var(--type-feed)] ring-1 ring-[var(--type-feed)]">
          02
        </span>
      </div>
    </div>
  );
}

function BoardStep() {
  const { t } = useTranslation();
  return (
    <StepText title={t('wizard.boardTitle')}>
      <p>{t('wizard.boardBody')}</p>
      <BoardSketch />
      <ul className="mt-5 flex flex-col gap-2.5">
        {(['boardPoint1', 'boardPoint2', 'boardPoint3'] as const).map((key) => (
          <li key={key} className="flex items-start gap-2.5">
            <span aria-hidden="true" className="mt-[7px] h-1 w-1 flex-none rounded-full bg-accent" />
            <span>{t(`wizard.${key}`)}</span>
          </li>
        ))}
      </ul>
    </StepText>
  );
}

function CarrierStep({
  carrierMatch,
  feedCarrier,
  onPair,
}: {
  carrierMatch: CarrierMatch | null;
  feedCarrier: FeedCarrier;
  onPair: () => void;
}) {
  const { t } = useTranslation();
  const paired = carrierMatch !== null && matchesCarrier(carrierMatch, feedCarrier);
  return (
    <StepText title={t('wizard.carrierTitle')}>
      <p>{t('wizard.carrierBody')}</p>
      {carrierMatch && !paired && (
        <div className="mt-5 flex items-center justify-between gap-3 border border-line-strong rounded-ctl px-3.5 py-2.5">
          <span className="text-[11.5px] text-text-secondary">
            {t('settings.feedCarrierDetected', { driver: carrierMatch.driver.display })}
          </span>
          <button
            type="button"
            onClick={onPair}
            className="shrink-0 rounded bg-accent px-3 py-1.5 text-[11px] font-medium text-accent-ink outline-none transition-colors hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {t('settings.feedCarrierApply')}
          </button>
        </div>
      )}
      {paired && (
        <div className="mt-5 border border-line-strong rounded-ctl px-3.5 py-2.5 text-[11.5px] text-accent">
          {t('settings.feedCarrierPaired', { driver: carrierMatch!.driver.display })}
        </div>
      )}
      {!carrierMatch && (
        <div className="mt-5 flex items-center justify-between gap-3 border border-line-strong rounded-ctl px-3.5 py-2.5">
          <span className="text-[11.5px] leading-relaxed text-text-secondary">
            {t('wizard.carrierMissing')}
          </span>
          <button
            type="button"
            onClick={() => void openCarrierDownload('vb-cable')}
            className="shrink-0 rounded border border-line px-3 py-1.5 text-[11px] font-medium text-text-secondary outline-none transition-colors hover:border-accent/50 hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {t('settings.feedCarrierDownload')}
          </button>
        </div>
      )}
    </StepText>
  );
}

function BackgroundStep({
  autostart,
  onAutostart,
  closeToTray,
  onCloseToTray,
}: {
  autostart: boolean;
  onAutostart: () => void;
  closeToTray: boolean;
  onCloseToTray: () => void;
}) {
  const { t } = useTranslation();
  return (
    <StepText title={t('wizard.backgroundTitle')}>
      <p>{t('wizard.backgroundBody')}</p>
      <div className="mt-5 flex flex-col">
        <div className="flex items-center justify-between gap-4 py-2.5">
          <div className="max-w-[46ch]">
            <div className="text-[12.5px] text-text-primary">{t('wizard.backgroundAutostart')}</div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-text-muted">
              {t('wizard.backgroundAutostartHint')}
            </div>
          </div>
          <Switch checked={autostart} onChange={onAutostart} label={t('wizard.backgroundAutostart')} />
        </div>
        <div className="flex items-center justify-between gap-4 border-t border-line py-2.5">
          <div className="max-w-[46ch]">
            <div className="text-[12.5px] text-text-primary">
              {t('wizard.backgroundCloseToTray')}
            </div>
            <div className="mt-0.5 text-[11px] leading-relaxed text-text-muted">
              {t('wizard.backgroundCloseToTrayHint')}
            </div>
          </div>
          <Switch
            checked={closeToTray}
            onChange={onCloseToTray}
            label={t('wizard.backgroundCloseToTray')}
          />
        </div>
      </div>
    </StepText>
  );
}
