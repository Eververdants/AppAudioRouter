import { useTranslation } from 'react-i18next';
import { Ring } from '@/components/ui/Ring';
import { DELAY_MAX_MS, clampDelay, formatDelaySigned, formatStep } from '@/lib/delay';
import { PRIMARY_VOLUME_MAX, PRIMARY_VOLUME_MIN } from '@/lib/types';
import { useRouterStore } from '@/stores/routerStore';
import { StripValue } from './StripValue';
import type { InspectorKey } from './shared';

/** The bottom strip of the board: the levers that exist for the clicked row.
 *  It is only mounted while a row is picked — the caller decides that — so
 *  everything here may assume the row it names is on the plan. */
export function Inspector({
  inspectorKey,
  onClear,
  drawn,
  deviceLatencyMs,
}: {
  inspectorKey: InspectorKey;
  onClear: () => void;
  drawn: string[];
  deviceLatencyMs: Record<string, number>;
}) {
  const { t } = useTranslation();
  const devices = useRouterStore((s) => s.devices);
  const sessions = useRouterStore((s) => s.sessions);
  const selectedPids = useRouterStore((s) => s.selectedPids);
  const deviceDelays = useRouterStore((s) => s.deviceDelays);
  const delayStepMs = useRouterStore((s) => s.delayStepMs);
  const deviceVolumes = useRouterStore((s) => s.deviceVolumes);
  const primaryVolumes = useRouterStore((s) => s.primaryVolumes);
  const setPrimaryVolume = useRouterStore((s) => s.setPrimaryVolume);
  const setDeviceVolume = useRouterStore((s) => s.setDeviceVolume);
  const setDeviceDelayValue = useRouterStore((s) => s.setDeviceDelayValue);

  const exeName = sessions.find((s) => s.pid === selectedPids[0])?.exe_name;
  const deviceId = inspectorKey.slice(4);
  const device = devices.find((d) => d.id === deviceId);
  // A staged device that has left `devices` is named as one that has left, not
  // by its GUID — the strip speaks to the user, and between two refreshes the
  // honest sentence is "this one is gone", not an unreadable identifier.
  const deviceLabel = device?.name ?? t('stage.deviceGone');
  // The strip only exists while the plan has copies (`drawn.length > 1`, the
  // caller's guard), so a device at index 0 is the primary and every other one
  // is a copy. A device whose delay is not the group's smallest is still a
  // mirror; the role words below follow the plan's own order.
  const isPrimary = drawn.indexOf(deviceId) === 0;

  let body: React.ReactNode;
  if (isPrimary) {
    const volume = primaryVolumes[exeName ?? ''] ?? 100;
    // The strip keeps painting for as long as its exit animation runs, and by
    // then the program it tunes may have left the session list. Writing through
    // an empty key would land in the user's config as a rule no process matches.
    const stepPrimary = (percent: number) => {
      if (exeName === undefined) return;
      void setPrimaryVolume(exeName, percent);
    };
    body = (
      <>
        <div className="flex items-center gap-2.5">
          <Ring tone="main" size={14} />
          <span>
            <span className="block text-[12.5px] font-bold">{deviceLabel}</span>
            <span className="text-xs text-text-muted">{t('stage.main')}</span>
          </span>
        </div>
        <StripValue
          kind="primary"
          label={t('stage.stripPrimaryVolume')}
          title={t('primaryVolume.hint')}
          value={volume}
          min={PRIMARY_VOLUME_MIN}
          max={PRIMARY_VOLUME_MAX}
          step={5}
          format={(v) => `${v}%`}
          unit=""
          neutral={volume === 100}
          ariaLabel={t('primaryVolume.hint')}
          stepLabels={{
            up: t('primaryVolume.stepUp', { step: '5%' }),
            down: t('primaryVolume.stepDown', { step: '5%' }),
          }}
          onCommit={(next) => stepPrimary(next)}
        />
        <span className="text-xs text-text-muted">{t('stage.stripPrimaryNote')}</span>
      </>
    );
  } else {
    const delay = deviceDelays[deviceId] ?? 0;
    const share = deviceVolumes[deviceId] ?? 100;
    const latency = deviceLatencyMs[deviceId];
    body = (
      <>
        <div className="flex items-center gap-2.5">
          <Ring tone="copy" size={14} />
          <span>
            <span className="block text-[12.5px] font-bold">{deviceLabel}</span>
            <span className="text-xs text-text-muted">{t('stage.copy')}</span>
          </span>
        </div>
        <StripValue
          kind="delay"
          label={t('stage.stripDelay')}
          title={
            latency !== undefined
              ? t('deviceLatency.reading', { ms: latency })
              : t('deviceDelay.valueLabel', { device: deviceLabel })
          }
          value={delay}
          min={-DELAY_MAX_MS}
          max={DELAY_MAX_MS}
          step={delayStepMs}
          format={(v) => formatDelaySigned(v)}
          unit="ms"
          neutral={delay === 0}
          ariaLabel={t('deviceDelay.valueLabel', { device: deviceLabel })}
          stepLabels={{
            up: t('deviceDelay.stepUp', { step: formatStep(delayStepMs) }),
            down: t('deviceDelay.stepDown', { step: formatStep(delayStepMs) }),
          }}
          onCommit={(next) => void setDeviceDelayValue(deviceId, clampDelay(next))}
        />
        <StripValue
          kind="share"
          label={t('stage.stripShare')}
          title={t('deviceVolume.valueLabel', { device: deviceLabel })}
          value={share}
          min={0}
          max={100}
          step={5}
          format={(v) => `${v}%`}
          unit=""
          neutral={share === 100}
          ariaLabel={t('deviceVolume.valueLabel', { device: deviceLabel })}
          stepLabels={{
            up: t('deviceVolume.stepUp', { step: '5%' }),
            down: t('deviceVolume.stepDown', { step: '5%' }),
          }}
          onCommit={(next) => void setDeviceVolume(deviceId, next)}
        />
      </>
    );
  }

  return (
    <div
      data-tuner-strip
      className="flex flex-none items-center gap-4 overflow-x-auto border-t border-line px-4 py-2.5"
    >
      <button
        type="button"
        onClick={onClear}
        className="pressable hit flex h-5 w-5 flex-none items-center justify-center rounded-full text-xs text-text-muted hover:bg-surface-hover hover:text-text-primary focus-visible:bg-surface-hover focus-visible:text-text-primary"
        title={t('stage.inspectClear')}
        aria-label={t('stage.inspectClear')}
      >
        ✕
      </button>
      {body}
      {/* A primary delay reading would describe a stream that does not exist:
          the system plays this device itself. The strip says so in words. */}
      {isPrimary && (
        <span className="text-xs text-text-muted">{t('stage.stripPrimaryLatency')}</span>
      )}
    </div>
  );
}
