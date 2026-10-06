import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@/components/ui/Tooltip';
import { orderByDelay } from '@/lib/delay';
import { MAIN_THREAD_TRANSFORM, SPRING_GLIDE, SPRING_TAP } from '@/lib/motion';
import { alreadyApplied } from '@/lib/stage';
import type { AudioDevice } from '@/lib/types';
import { useRouterStore } from '@/stores/routerStore';

/** One line of the briefing: one programme, said plainly. */
interface BriefingLine {
  /** Stable React key: the pid the line is about. */
  key: string;
  text: string;
  /** The programme exists but is not rendering audio right now. */
  quiet: boolean;
}

/** A device's name for a sentence, or its id when the list has lost it. */
function deviceNameOf(deviceId: string | undefined, devices: AudioDevice[]): string {
  if (deviceId === undefined) return '';
  return devices.find((device) => device.id === deviceId)?.name ?? deviceId;
}

/**
 * One list formatter per language, built the first time it is needed.
 *
 * `Intl.ListFormat` carries a locale's whole conjunction grammar, and
 * building one is by far the expensive half of joining three device names.
 * The briefing recomputes whenever a programme starts or stops making a
 * sound — which on a live machine is often — and every line of it built
 * its own, so the same object was being built several times a second.
 *
 * A language the runtime cannot build one for is remembered as such, so it
 * costs one failed construction for the whole run instead of one per line.
 */
const listFormatters = new Map<string, Intl.ListFormat | null>();

function listFormatter(language: string): Intl.ListFormat | null {
  const cached = listFormatters.get(language);
  if (cached !== undefined) return cached;
  let built: Intl.ListFormat | null = null;
  try {
    built = new Intl.ListFormat(language, { type: 'conjunction' });
  } catch {
    built = null;
  }
  listFormatters.set(language, built);
  return built;
}

/** "A, B and C" in the language the window is speaking. */
function joinNames(names: string[], language: string): string {
  return listFormatter(language)?.format(names) ?? names.join(', ');
}

/**
 * The briefing: a button that answers "where is sound going right now?" in as
 * many words as it takes, no fewer and no more.
 *
 * Everything the stage draws is geometry — lit discs, spokes, role words — and
 * geometry has to be read. This is the same answer as prose: one line per
 * routed programme naming where its sound comes out, one line when nothing is
 * redirected at all, and one line when the stage holds changes that have not
 * landed. It reports; it does not route, warn or advise — the place for actions
 * is where the things being acted on are.
 *
 * It lives in the corner the action dock used to occupy: out of the layout,
 * out of the ring's way, and within reach of the eye that just asked the
 * question.
 */
export function StatusBriefing() {
  const { t, i18n } = useTranslation();
  const devices = useRouterStore((s) => s.devices);
  const sessions = useRouterStore((s) => s.sessions);
  const routedPids = useRouterStore((s) => s.routedPids);
  const soundingPids = useRouterStore((s) => s.soundingPids);
  const defaultDeviceId = useRouterStore((s) => s.defaultDeviceId);
  const selectedPids = useRouterStore((s) => s.selectedPids);
  const selectedDeviceIds = useRouterStore((s) => s.selectedDeviceIds);
  const deviceDelays = useRouterStore((s) => s.deviceDelays);
  const feeds = useRouterStore((s) => s.feeds);

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    // Capture, and registered only while the bubble is up: the key that closes
    // it must not also land in whatever sits underneath, and a standing
    // listener would swallow the search box's Escape for the whole session.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [open]);

  const lines = useMemo<BriefingLine[]>(() => {
    const result: BriefingLine[] = [];
    for (const session of sessions) {
      const ids = routedPids[session.pid];
      const name = session.display_name ?? session.exe_name;
      const quiet = soundingPids[session.pid] !== true;
      if (ids !== undefined && ids.length > 0) {
        if (ids.length === 1) {
          result.push({
            key: `${session.pid}`,
            text: t('briefing.routeOne', { process: name, device: deviceNameOf(ids[0], devices) }),
            quiet,
          });
        } else {
          const joined = joinNames(
            ids.map((id) => deviceNameOf(id, devices)),
            i18n.language,
          );
          result.push({
            key: `${session.pid}`,
            text: t('briefing.routeMulti', { process: name, devices: joined }),
            quiet,
          });
        }
      }
      // Feeds are their own line: "plays from" and "is fed into" are two facts
      // about one program, and cramming them into one sentence reads worse than
      // two short ones. A feed held by a device route says so — silence with no
      // reason reads as a bug.
      const feedPids = feeds[session.pid] ?? [];
      if (feedPids.length > 0) {
        const targets = feedPids
          .map((targetPid) => sessions.find((s) => s.pid === targetPid))
          .filter((s) => s !== undefined)
          .map((s) => s.display_name ?? s.exe_name);
        const joined = joinNames(targets, i18n.language);
        result.push({
          key: `${session.pid}-feed`,
          text:
            ids !== undefined && ids.length > 0
              ? t('briefing.feedHeldLine', { process: name, targets: joined })
              : t('briefing.feedLine', { process: name, targets: joined }),
          quiet,
        });
      }
    }
    if (result.length === 0) {
      const fallback = deviceNameOf(defaultDeviceId ?? undefined, devices);
      result.push({
        key: 'none',
        text:
          defaultDeviceId !== null && fallback !== ''
            ? t('briefing.empty', { device: fallback })
            : t('briefing.emptyNoDevice'),
        quiet: false,
      });
    }
    return result;
  }, [sessions, routedPids, soundingPids, devices, defaultDeviceId, feeds, t, i18n.language]);

  // Changes staged on the stage that the hub has not landed yet — worth a
  // line, because "the picture and the sound disagree" is the one thing this
  // screen cannot say in a single glance.
  const staged = orderByDelay(selectedDeviceIds, deviceDelays);
  const pending = staged.length > 0 && !alreadyApplied(staged, selectedPids, routedPids);

  return (
    // Anchored above the board's tuning strip, not at the very bottom of the
    // work area: the strip occupies the bottom band, and a floating button that
    // covered its left-hand controls would swallow their clicks.
    <div ref={rootRef} className="pointer-events-none absolute bottom-[56px] left-4 z-30">
      <div className="pointer-events-auto relative">
        <AnimatePresence>
          {open && (
            <motion.div
              key="briefing"
              role="status"
              aria-label={t('briefing.title')}
              initial={{ opacity: 0, y: 8, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.98 }}
              transition={SPRING_GLIDE}
              transformTemplate={MAIN_THREAD_TRANSFORM}
              className="bg-surface border border-line shadow-float absolute bottom-full left-0 mb-2 w-[300px] rounded-card p-3.5"
            >
              <ul className="flex flex-col gap-2">
                {lines.map((line) => (
                  <li key={line.key} className="text-[12px] leading-relaxed text-text-secondary">
                    {line.text}
                    {line.quiet && <span className="text-text-muted"> {t('briefing.quiet')}</span>}
                  </li>
                ))}
                {pending && (
                  <li className="border-t border-line pt-2 text-[12px] font-medium leading-relaxed text-accent">
                    {t('briefing.staged')}
                  </li>
                )}
              </ul>
            </motion.div>
          )}
        </AnimatePresence>
        <Tooltip label={open ? '' : t('briefing.tooltip')}>
          <motion.button
            type="button"
            aria-expanded={open}
            aria-label={t('briefing.tooltip')}
            onClick={() => setOpen((value) => !value)}
            whileTap={{ scale: 0.94 }}
            whileHover={{ scale: 1.05 }}
            transition={SPRING_TAP}
            className={`flex h-8 items-center gap-1.5 rounded-full border px-3 text-[11.5px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60 ${
              open
                ? 'border-accent/60 bg-accent-muted text-accent'
                : 'border-line bg-surface text-text-secondary hover:text-text-primary'
            }`}
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
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
            </svg>
            {t('briefing.button')}
          </motion.button>
        </Tooltip>
      </div>
    </div>
  );
}
