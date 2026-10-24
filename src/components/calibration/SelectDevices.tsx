import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { PickRow } from '@/components/calibration/PickRow';
import { FADE, MAIN_THREAD_TRANSFORM } from '@/lib/motion';
import type { AudioDevice } from '@/lib/types';

/**
 * The wizard's first screen: which devices take part, and the two ways out of
 * it — 取消 leaves the page, 开始测量 starts a run.
 *
 * The rows are the machine's whole device list, not a filtered one: a device
 * with no route can still be measured here, and its number is what the next
 * route inherits.
 */
export function SelectDevices({
  devices,
  selectedIds,
  toggleDevice,
  cancelRun,
  onClose,
  beginMeasure,
}: {
  devices: AudioDevice[];
  selectedIds: string[];
  toggleDevice: (id: string) => void;
  cancelRun: () => void;
  onClose: () => void;
  beginMeasure: () => void;
}) {
  const { t } = useTranslation();
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={FADE}
      transformTemplate={MAIN_THREAD_TRANSFORM}
    >
      <p className="mt-2 text-[12px] leading-relaxed text-text-secondary">
        {t('calibration.intro')}
      </p>
      <fieldset className="mt-4">
        <legend className="text-[11px] font-medium text-text-muted">
          {t('calibration.pickDevices')}
        </legend>
        <div className="mt-1.5 max-h-[46vh] space-y-1 overflow-y-auto pr-1">
          {devices.map((d) => (
            <PickRow
              key={d.id}
              label={d.name}
              picked={selectedIds.includes(d.id)}
              onToggle={() => toggleDevice(d.id)}
            />
          ))}
        </div>
      </fieldset>
      <div className="mt-5 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            cancelRun();
            onClose();
          }}
          className="pressable rounded-ctl border border-line px-3 py-1.5 text-[11px] font-medium text-text-secondary outline-none hover:border-accent/50 hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          {t('calibration.cancel')}
        </button>
        <button
          type="button"
          disabled={selectedIds.length < 2}
          onClick={beginMeasure}
          className="pressable flex items-center gap-1.5 rounded-ctl bg-accent px-3 py-1.5 text-[11px] font-medium text-accent-ink outline-none hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-60"
        >
          {t('calibration.start')}
        </button>
      </div>
    </motion.div>
  );
}
