import { AnimatePresence, motion } from 'framer-motion';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmButton } from '@/components/ui/ConfirmButton';
import { Ring } from '@/components/ui/Ring';
import { orderByDelay } from '@/lib/delay';
import { FADE, SPRING_ARRIVE, SPRING_TAP } from '@/lib/motion';
import { alreadyApplied } from '@/lib/stage';
import { useRouterStore } from '@/stores/routerStore';

/**
 * The bar along the bottom of the work area: one sentence and one button.
 *
 * Routing takes over the sound of programmes — several at once when they were
 * picked together, onto every device in the plan — so it is the one action here
 * that must never be a stray click. Nothing on the stage changes until this says
 * Apply and Apply is pressed, and even then there is a few seconds worth of Undo
 * in the toast. The sentence is plain because the thing it describes is plain:
 * "music.exe will play through Speakers + TV". No goatee adjectives like routed,
 * mirrored or primary survive anywhere near it.
 *
 * It floats over the stage rather than sitting in the layout, so nothing is
 * displaced by it and the ring behind stays usable.
 */
export function ActionDock() {
  const { t } = useTranslation();
  const devices = useRouterStore((s) => s.devices);
  const sessions = useRouterStore((s) => s.sessions);
  const selectedPids = useRouterStore((s) => s.selectedPids);
  const selectedDeviceIds = useRouterStore((s) => s.selectedDeviceIds);
  const deviceDelays = useRouterStore((s) => s.deviceDelays);
  const routedPids = useRouterStore((s) => s.routedPids);
  const applying = useRouterStore((s) => s.applying);
  const applyRoute = useRouterStore((s) => s.applyRoute);
  const selectProcess = useRouterStore((s) => s.selectProcess);
  const stopRoute = useRouterStore((s) => s.stopRoute);
  const stopAllRoutes = useRouterStore((s) => s.stopAllRoutes);

  const pid = selectedPids[0];
  const session = pid === undefined ? undefined : sessions.find((s) => s.pid === pid);
  // The plan reads in the order the apply will realize it — delay order, the
  // order the route goes out in — so the sentence names the device the system
  // will actually play first, and "already applied" compares like with like:
  // live routes are kept in that same order. A pick order the delay order
  // would overwrite has no plan of its own to describe, which is why the
  // stage never drew one.
  const staged = orderByDelay(selectedDeviceIds, deviceDelays);
  const targets = staged.map((id) => devices.find((d) => d.id === id)?.name ?? id).join(' + ');
  const answered = alreadyApplied(staged, selectedPids, routedPids);
  const nothingPicked = pid === undefined || staged.length === 0;

  const sentenceKey = nothingPicked
    ? 'guide'
    : answered
      ? `unchanged:${targets}`
      : `${selectedPids.join(',')}:${targets}`;
  const sentence: ReactNode =
    nothingPicked
      ? t('dock.guide')
      : answered
        ? t('dock.unchanged', { device: targets })
        : selectedPids.length > 1
          ? t('dock.previewMany', { n: selectedPids.length, device: targets })
          : t('dock.preview', {
              process: session?.display_name ?? session?.exe_name ?? '',
              device: targets,
            });

  /**
   * The way back to the system default, at whatever scope the selection implies:
   * the programmes picked, or — with nothing picked — every routed programme,
   * because "back to default" is the only way out of a route nobody is looking
   * at.
   */
  const routedSelection = selectedPids.filter((p) => routedPids[p] !== undefined);
  const anythingRouted = Object.keys(routedPids).length > 0;
  const returnScope =
    routedSelection.length > 0
      ? () => {
          for (const p of routedSelection) void stopRoute(p);
        }
      : selectedPids.length === 0 && anythingRouted
        ? () => void stopAllRoutes()
        : null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center px-4">
      <motion.div
        role="group"
        aria-label={t('dock.groupLabel')}
        // The dock arrives after the stage it sits over, and from below: it is
        // the answer to what is on the stage, so it should read as having been
        // asked rather than as having been there all along.
        initial={{ y: 18, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ ...SPRING_ARRIVE, delay: 0.12 }}
        // A capsule, not a bar: the dock floats over the stage, and floating
        // chrome in this surface is a pill of glass hugging what it carries.
        className="glass squircle pointer-events-auto flex max-w-full items-center gap-2 rounded-full py-2 pl-4 pr-2"
      >
        <Ring size={12} tone={answered || nothingPicked ? 'idle' : 'main'} />
        {/* The sentence is replaced, not edited in place. What it says is the
            whole of what this bar is for, and a line of text that silently
            rewrites itself is a line nobody re-reads. */}
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={sentenceKey}
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            transition={FADE}
            className="min-w-0 truncate text-[12px] text-text-secondary"
          >
            {sentence}
          </motion.span>
        </AnimatePresence>

        {returnScope !== null && (
          <>
            <span aria-hidden="true" className="h-4 w-px flex-none bg-line" />
            <ConfirmButton
              label={t('dock.backToDefault')}
              confirmLabel={t('dock.backToDefaultConfirm')}
              onConfirm={returnScope}
            />
          </>
        )}

        {nothingPicked || answered ? null : (
          <motion.button
            type="button"
            // Re-reading the route back into the stage: the store's own act of
            // selecting a programme is what prefills the plan from reality, so
            // "throw my picks away" and "select it again" are one operation.
            onClick={() => {
              if (pid !== undefined) selectProcess(pid);
            }}
            whileTap={{ scale: 0.94 }}
            transition={SPRING_TAP}
            className="squircle flex-none rounded-full px-3 py-1 text-[11.5px] text-text-muted outline-none transition-colors hover:bg-surface-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {t('dock.revert')}
          </motion.button>
        )}

        <motion.button
          type="button"
          onClick={() => void applyRoute()}
          disabled={applying || nothingPicked || answered}
          // The press is the confirmation: this is the one button that changes
          // what everybody hears, and it has to feel like it took a finger — so
          // it squashes rather than shrinking, the way a soft body deforms.
          whileTap={
            applying || nothingPicked || answered ? undefined : { scaleX: 1.06, scaleY: 0.9 }
          }
          whileHover={applying || nothingPicked || answered ? undefined : { scale: 1.04 }}
          transition={SPRING_TAP}
          className="squircle flex-none rounded-full bg-accent px-4 py-1 text-[11.5px] font-semibold text-accent-ink outline-none transition-colors hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-default disabled:bg-glass disabled:text-text-muted disabled:hover:bg-glass"
        >
          {t('dock.apply')}
        </motion.button>
      </motion.div>
    </div>
  );
}
