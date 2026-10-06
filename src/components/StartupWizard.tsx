import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Ring } from '@/components/ui/Ring';
import { Switch } from '@/components/ui/Switch';
import { detectCarrierPair, matchesCarrier, type CarrierMatch } from '@/lib/carrierDetect';
import { openCarrierDownload } from '@/lib/invoke';
import { FADE, MAIN_THREAD_TRANSFORM } from '@/lib/motion';
import type { FeedCarrier } from '@/lib/types';
import { useRouterStore } from '@/stores/routerStore';

/** The four stops of the tour, in the order a new user needs them. */
const STEPS = 4;

/**
 * Text that arrives one character at a time, each sharpening out of a blur. A
 * one-shot entrance — nothing loops and nothing lingers: the filter is a blur
 * only while the character is still landing. Chars are aria-hidden behind a
 * label on the wrapper, so a screen reader hears the sentence, not a spelling
 * bee. Delays are the documented per-item pattern: one base per block, one
 * small step per character.
 *
 * Every char carries the identity `transformTemplate` on purpose: Motion runs
 * opacity/filter on the WAAPI path otherwise, and a WAAPI finish cancels the
 * animation one frame before the final value is committed — for that frame the
 * char falls back to its inline base (invisible, blurred) and blinks exactly
 * as it lands. Main-thread animation commits inline styles every frame, so a
 * char sharpens once and stays sharp. Plain inline chars, not inline-block:
 * an English word must never wrap mid-word just because each letter is its
 * own box.
 */
function BlurText({
  text,
  base = 0,
  step = 0.006,
  className,
}: {
  text: string;
  base?: number;
  step?: number;
  className?: string;
}) {
  return (
    <span aria-label={text} className={className}>
      {Array.from(text).map((ch, i) => (
        <motion.span
          key={i}
          aria-hidden="true"
          initial={{ opacity: 0, filter: 'blur(6px)' }}
          animate={{ opacity: 1, filter: 'blur(0px)' }}
          transition={{ ...FADE, delay: base + i * step }}
          transformTemplate={MAIN_THREAD_TRANSFORM}
          className="inline whitespace-pre"
        >
          {ch}
        </motion.span>
      ))}
    </span>
  );
}

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
    // The tour is one big soft shape, not a card: the surface carries the
    // largest step of the radius ladder and no border at all — the rounding
    // is the statement, a hairline frame would just box the content again.
    // `.cc` is the progressive continuous-curvature cut for renderers that
    // know supercircles; where they don't, the large radii stand alone.
    <div className="flex h-full min-h-0 flex-col items-center justify-center px-10 py-6">
      <div className="cc flex w-full max-w-xl flex-col overflow-hidden rounded-window bg-surface">
        {/* Fixed body height so the panel does not breathe between steps; the
            shorter steps centre themselves inside it. */}
        <div className="flex min-h-[364px] flex-col justify-center px-9 py-8">
          <motion.div
            key={step}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={FADE}
            transformTemplate={MAIN_THREAD_TRANSFORM}
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
        </div>

        {/* Step marks are the app's own concentric rings, at indicator size:
            the outer ring is the stop, the lit core is where the tour stands.
            The tone switch is already animated inside `.con-ring`. */}
        <div className="flex items-center justify-between border-t border-line px-6 py-3.5">
          <div className="flex items-center gap-2" role="group" aria-label={t('wizard.stepsLabel')}>
            {Array.from({ length: STEPS }, (_, i) => (
              <Ring key={i} size={12} tone={i === step ? 'main' : 'idle'} />
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

/** The heading + prose every step shares. The title arrives first, one letter
 * at a time; the prose follows as a faster stream. */
function StepText({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h1 className="text-[19px] font-semibold tracking-tight text-text-primary">
        <BlurText text={title} base={0.05} step={0.022} />
      </h1>
      <div className="mt-3 text-[12.5px] leading-relaxed text-text-secondary">{children}</div>
    </div>
  );
}

/** Prose that joins the per-character arrival a beat after its title. */
function StepProse({ text, base = 0.35 }: { text: string; base?: number }) {
  return (
    <p>
      <BlurText text={text} base={base} />
    </p>
  );
}

/** A bullet row whose text streams in; the dot leads it. */
function StepBullet({ text, base }: { text: string; base: number }) {
  return (
    <li className="flex items-start gap-2.5">
      <span aria-hidden="true" className="mt-[7px] h-1 w-1 flex-none rounded-full bg-accent" />
      <span>
        <BlurText text={text} base={base} />
      </span>
    </li>
  );
}

/** Anything that is chrome rather than prose — rows, switches, buttons —
 * arrives as one piece, after the words it belongs to. Same main-thread rule
 * as the chars: a block that blinks dark for a frame as it lands reads as a
 * glitch, not an arrival. */
function StepBlock({ children, base = 0.85 }: { children: ReactNode; base?: number }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ ...FADE, delay: base }}
      transformTemplate={MAIN_THREAD_TRANSFORM}
    >
      {children}
    </motion.div>
  );
}

function WelcomeStep() {
  const { t } = useTranslation();
  return (
    <div>
      {/* The mark the whole interface is made of, at brand size: the outer
          ring says what the app is, the core says sound is its business. */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ ...FADE, delay: 0.02 }}
        transformTemplate={MAIN_THREAD_TRANSFORM}
        className="mb-5"
      >
        <Ring size={40} tone="main" />
      </motion.div>
      <h1 className="text-[19px] font-semibold tracking-tight text-text-primary">
        <BlurText text={t('wizard.welcomeTitle', { product: t('productName') })} base={0.05} step={0.022} />
      </h1>
      <div className="mt-3 text-[12.5px] leading-relaxed text-text-secondary">
        <StepProse text={t('wizard.welcomeBody')} />
        <ul className="mt-5 flex flex-col gap-2.5">
          <StepBullet text={t('wizard.welcomePoint1')} base={0.6} />
          <StepBullet text={t('wizard.welcomePoint2')} base={0.7} />
          <StepBullet text={t('wizard.welcomePoint3')} base={0.8} />
        </ul>
      </div>
    </div>
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
      <StepProse text={t('wizard.boardBody')} />
      <StepBlock base={0.7}>
        <BoardSketch />
      </StepBlock>
      <ul className="mt-5 flex flex-col gap-2.5">
        <StepBullet text={t('wizard.boardPoint1')} base={0.85} />
        <StepBullet text={t('wizard.boardPoint2')} base={0.95} />
        <StepBullet text={t('wizard.boardPoint3')} base={1.05} />
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
      <StepProse text={t('wizard.carrierBody')} />
      <StepBlock>
        {carrierMatch && !paired && (
          <div className="mt-5 flex items-center justify-between gap-3 rounded-ctl border border-line-strong px-3.5 py-2.5">
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
          <div className="mt-5 rounded-ctl border border-line-strong px-3.5 py-2.5 text-[11.5px] text-accent">
            {t('settings.feedCarrierPaired', { driver: carrierMatch!.driver.display })}
          </div>
        )}
        {!carrierMatch && (
          <div className="mt-5 flex items-center justify-between gap-3 rounded-ctl border border-line-strong px-3.5 py-2.5">
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
      </StepBlock>
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
      <StepProse text={t('wizard.backgroundBody')} />
      <StepBlock>
        <div className="mt-4 flex flex-col">
          <div className="flex items-center justify-between gap-4 py-2.5">
            <div className="max-w-[46ch]">
              <div className="text-[12.5px] text-text-primary">
                {t('wizard.backgroundAutostart')}
              </div>
              <div className="mt-0.5 text-[11px] leading-relaxed text-text-muted">
                {t('wizard.backgroundAutostartHint')}
              </div>
            </div>
            <Switch
              checked={autostart}
              onChange={onAutostart}
              label={t('wizard.backgroundAutostart')}
            />
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
      </StepBlock>
    </StepText>
  );
}
