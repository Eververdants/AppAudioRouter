import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { FADE, MAIN_THREAD_TRANSFORM } from '@/lib/motion';
import type { AudioDevice, RememberedRouteEntry } from '@/lib/types';

/**
 * One remembered route: the executable it belongs to, and the ✕ that forgets it.
 *
 * Auto-restore is a decision the app makes on the user's behalf, so it has to be
 * revocable from the same place it is switched on — without this, un-remembering
 * a route meant editing a JSON file by hand.
 */
export function RememberedChip({
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
  // A remembered device that is not on the list is a device that left, and the
  // tooltip says so: an endpoint id in a sentence nobody can read is the same
  // GUID-on-screen the capsule and the 「现状」 page were called out for.
  const target = entry.deviceIds
    .map((id) => devices.find((device) => device.id === id)?.name ?? t('settings.deviceGone'))
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
      className="flex max-w-full items-center gap-1 rounded-seg border border-line bg-surface-raised py-0.5 pl-1.5 pr-0.5 font-mono text-xs text-text-secondary"
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
