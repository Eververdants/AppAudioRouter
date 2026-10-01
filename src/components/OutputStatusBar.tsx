import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { ConfirmButton } from '@/components/ui/ConfirmButton';
import { FADE } from '@/lib/motion';
import { useRouterStore } from '@/stores/routerStore';

/**
 * The one-sentence answer to "where is the sound coming out right now".
 *
 * Everything else on the stage shows that answer in pieces — a badge on a
 * process row, a pulse on a device node, a count on the hub — and each piece
 * only reads as an answer once the whole model is understood. This bar is for
 * the user who has not built that model: one sentence, always on screen, that
 * names the program and the device.
 *
 * It is also the standing way back. Whenever something is playing away from
 * the system default, the bar offers "back to system default" — and because
 * that reaches programs the user may not be looking at, it asks once before
 * it acts, like every other confirm-in-place control here.
 */
export function OutputStatusBar() {
  const { t } = useTranslation();
  const sessions = useRouterStore((s) => s.sessions);
  const devices = useRouterStore((s) => s.devices);
  const selectedPids = useRouterStore((s) => s.selectedPids);
  const routedPids = useRouterStore((s) => s.routedPids);
  const defaultDeviceId = useRouterStore((s) => s.defaultDeviceId);
  const stopRoute = useRouterStore((s) => s.stopRoute);
  const stopAllRoutes = useRouterStore((s) => s.stopAllRoutes);

  const nameOf = (id: string | null | undefined): string | null =>
    id == null ? null : (devices.find((d) => d.id === id)?.name ?? null);
  const defaultName = nameOf(defaultDeviceId);
  const routedCount = Object.keys(routedPids).length;

  const firstPid = selectedPids[0];
  const firstSession =
    firstPid === undefined ? undefined : sessions.find((s) => s.pid === firstPid);

  let text: string;
  /** Accent when something is playing away from the default; muted for the
   * neutral states, so colour alone says "this needs your attention". */
  let accent = false;
  let onReturn: (() => void) | null = null;

  if (selectedPids.length === 1 && firstSession !== undefined && firstPid !== undefined) {
    const ids = routedPids[firstPid];
    if (ids !== undefined && ids.length > 0) {
      const primary = nameOf(ids[0]) ?? '';
      text =
        ids.length > 1
          ? t('statusBar.playingMore', {
              process: firstSession.exe_name,
              device: primary,
              m: ids.length - 1,
            })
          : t('statusBar.playing', { process: firstSession.exe_name, device: primary });
      accent = true;
      onReturn = () => void stopRoute(firstPid);
    } else {
      text = defaultName
        ? t('statusBar.following', { process: firstSession.exe_name, device: defaultName })
        : firstSession.exe_name;
    }
  } else if (selectedPids.length > 1) {
    text = t('statusBar.selectedMulti', { n: selectedPids.length });
    // A multi-selection can hold several routed programs; the way back takes
    // each of them home, which is exactly what the confirm question is for.
    const selectedRouted = selectedPids.filter((pid) => routedPids[pid] !== undefined);
    if (selectedRouted.length > 0) {
      accent = true;
      onReturn = () => {
        for (const pid of selectedRouted) void stopRoute(pid);
      };
    }
  } else if (routedCount > 0) {
    text = t('statusBar.someRouted', { n: routedCount });
    accent = true;
    onReturn = () => void stopAllRoutes();
  } else {
    text = defaultName ? t('statusBar.idleDefault', { device: defaultName }) : '';
  }

  return (
    <div className="flex flex-none items-center gap-2.5 rounded-2xl border border-glass bg-glass px-4 py-2 shadow-glass backdrop-blur-xl">
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
        className={`flex-none ${accent ? 'text-accent' : 'text-text-muted'}`}
      >
        <path d="M11 5 6 9H2v6h4l5 4V5z" />
        <path d="M15.5 8.5a5 5 0 0 1 0 7" />
        <path d="M18.5 5.5a9 9 0 0 1 0 13" />
      </svg>
      <motion.span
        // Keyed on the sentence itself, so a change of subject reads as a
        // change rather than as text mutating under the eye.
        key={text}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={FADE}
        className={`min-w-0 flex-1 truncate text-[12px] ${
          accent ? 'font-medium text-accent' : 'text-text-secondary'
        }`}
      >
        {text}
      </motion.span>
      {onReturn !== null && (
        <ConfirmButton
          label={t('statusBar.backToDefault')}
          confirmLabel={t('statusBar.backToDefaultConfirm')}
          onConfirm={onReturn}
        />
      )}
    </div>
  );
}
