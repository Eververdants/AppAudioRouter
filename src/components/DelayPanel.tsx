import { AnimatePresence, motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { DelayStepper } from '@/components/ui/DelayStepper';
import { Switch } from '@/components/ui/Switch';
import { formatStep, rangeSeconds } from '@/lib/delay';
import { useRouterStore } from '@/stores/routerStore';

/**
 * Delay compensation panel below the router stage.
 *
 * Deliberately a permanent part of the stage: the controls used to hide inside
 * the device chips of a small bar and only reacted to a click, which left the
 * feature looking unadjustable. The panel names itself, carries the sync
 * toggle, and gives every duplicated device an explicit −/value/+ control
 * (stepping by the configured step, signed, bounded by the range from the
 * settings). The primary device is listed but cannot be delayed — the OS plays
 * it directly.
 */
export function DelayPanel() {
  const { t } = useTranslation();
  const devices = useRouterStore((s) => s.devices);
  const selectedPids = useRouterStore((s) => s.selectedPids);
  const selectedDeviceIds = useRouterStore((s) => s.selectedDeviceIds);
  const delaySync = useRouterStore((s) => s.delaySync);
  const toggleDelaySync = useRouterStore((s) => s.toggleDelaySync);
  const delayRangeMs = useRouterStore((s) => s.delayRangeMs);
  const delayStepMs = useRouterStore((s) => s.delayStepMs);

  const rows =
    selectedPids.length > 0
      ? selectedDeviceIds.map((id, index) => ({
          id,
          index,
          name: devices.find((d) => d.id === id)?.name ?? id,
        }))
      : [];
  const range = rangeSeconds(delayRangeMs);
  const step = formatStep(delayStepMs);

  return (
    <div className="w-full flex-none rounded-2xl border border-glass bg-glass px-3 py-2 shadow-glass backdrop-blur-xl">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <polyline points="12 7 12 12 15.5 14" />
          </svg>
          {t('delayPanel.title')}
        </span>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-text-muted">{t('delayPanel.sync')}</span>
          <Switch
            checked={delaySync}
            onChange={() => void toggleDelaySync()}
            label={t('delayPanel.sync')}
          />
        </div>
      </div>

      <AnimatePresence mode="wait" initial={false}>
        {rows.length === 0 ? (
          <motion.p
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="mt-1 text-[10px] leading-relaxed text-text-muted"
          >
            {t('delayPanel.emptyHint', { step, range })}
          </motion.p>
        ) : (
          <motion.div
            key="rows"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="mt-1.5 max-h-32 space-y-1 overflow-y-auto"
          >
            {rows.map((row) => (
              <div key={row.id} className="flex items-center gap-2">
                <span className="flex h-3.5 w-3.5 flex-none items-center justify-center rounded-full bg-accent-muted text-[8px] font-semibold leading-none text-accent">
                  {row.index + 1}
                </span>
                <span
                  className={`min-w-0 flex-1 truncate text-[11px] ${
                    row.index === 0 ? 'text-text-muted' : 'text-text-secondary'
                  }`}
                  title={row.name}
                >
                  {row.name}
                </span>
                {row.index === 0 ? (
                  <span
                    className="flex-none pr-1 text-[10px] text-text-muted"
                    title={t('delayPanel.primaryHint')}
                  >
                    {t('delayPanel.primary')}
                  </span>
                ) : (
                  <DelayStepper deviceId={row.id} name={row.name} rangeMs={delayRangeMs} />
                )}
              </div>
            ))}
            <p className="pt-0.5 text-[9px] leading-relaxed text-text-muted">
              {t('delayPanel.hint', { step, range })}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
