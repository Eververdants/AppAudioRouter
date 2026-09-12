import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useRouterStore } from '@/stores/routerStore';

/**
 * Delay compensation bar shown under the router stage while a process and
 * devices are selected. Clicking a mirror device cycles its delay preset; the
 * primary device cannot be delayed (the OS plays it directly), so the lagging
 * device — usually Bluetooth — should be selected first instead.
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
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 6 }}
          className="flex w-full flex-wrap items-center gap-1.5 px-1 pb-1"
        >
          <span className="mr-1 text-[10px] leading-tight text-text-muted">
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
                <span className={delay > 0 ? 'font-semibold' : 'text-text-muted'}>
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
              <button
                key={id}
                type="button"
                onClick={() => void cycleDeviceDelay(id)}
                title={t('delayBar.deviceHint', { device: name })}
                className={`flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] transition-colors ${chipClass}`}
              >
                {inner}
              </button>
            );
          })}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
