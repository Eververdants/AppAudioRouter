import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useRouterStore } from '@/stores/routerStore';

/**
 * Delay compensation bar shown under the router stage while a process and
 * devices are selected. Clicking a mirror device cycles its delay preset; the
 * primary device cannot be delayed (the OS plays it directly), so the lagging
 * device — usually Bluetooth — should be selected first instead. The same
 * values are editable as sliders in the settings panel.
 */
export function DelayBar() {
  const { t } = useTranslation();
  const devices = useRouterStore((s) => s.devices);
  const selectedPid = useRouterStore((s) => s.selectedPid);
  const selectedDeviceIds = useRouterStore((s) => s.selectedDeviceIds);
  const deviceDelays = useRouterStore((s) => s.deviceDelays);
  const cycleDeviceDelay = useRouterStore((s) => s.cycleDeviceDelay);

  const visible = selectedPid !== null && selectedDeviceIds.length > 0;

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 6, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: 0.98 }}
          transition={{ type: 'spring', stiffness: 380, damping: 30 }}
          className="flex w-full flex-wrap items-center justify-center gap-1.5 rounded-full border border-glass bg-glass px-3 py-1.5 shadow-glass backdrop-blur-xl"
        >
          <span className="mr-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-text-muted">
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <circle cx="12" cy="13" r="8" />
              <path d="M12 9v4l2.5 2.5M9 2h6" />
            </svg>
            {t('delayBar.title')}
          </span>
          {selectedDeviceIds.map((id, index) => {
            const name = devices.find((d) => d.id === id)?.name ?? id;
            const delay = deviceDelays[id] ?? 0;
            const isPrimary = index === 0;
            const chipClass = isPrimary
              ? 'cursor-default border-border bg-bg-tertiary text-text-muted'
              : delay > 0
                ? 'cursor-pointer border-accent bg-accent-muted text-accent hover:border-accent-hover'
                : 'cursor-pointer border-border bg-bg-secondary text-text-secondary hover:border-accent hover:text-accent';
            const inner = (
              <>
                <span
                  className={`flex h-3.5 w-3.5 flex-none items-center justify-center rounded-full text-[8px] font-semibold leading-none ${
                    isPrimary ? 'bg-accent text-white' : 'bg-accent-muted text-accent'
                  }`}
                >
                  {index + 1}
                </span>
                <span className="max-w-28 truncate">{name}</span>
                <span className={`tabular-nums ${delay > 0 ? 'font-semibold' : 'text-text-muted'}`}>
                  {isPrimary ? t('delayBar.primary') : `${delay} ms`}
                </span>
              </>
            );
            return isPrimary ? (
              <span
                key={id}
                title={t('delayBar.primaryHint')}
                className={`flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] ${chipClass}`}
              >
                {inner}
              </span>
            ) : (
              <motion.button
                key={id}
                type="button"
                layout
                onClick={() => void cycleDeviceDelay(id)}
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.92 }}
                transition={{ type: 'spring', stiffness: 480, damping: 26 }}
                title={t('delayBar.deviceHint', { device: name })}
                className={`flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${chipClass}`}
              >
                {inner}
              </motion.button>
            );
          })}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
