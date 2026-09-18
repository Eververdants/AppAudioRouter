import { useTranslation } from 'react-i18next';
import { ScrubReadout } from '@/components/ui/ScrubReadout';
import { useRouterStore } from '@/stores/routerStore';

/** Travel worth one step: 20 steps of 5 % across roughly 60 px. */
const PX_PER_STEP = 3;
/** One notch of the percentage. */
const VOLUME_STEP = 5;

/**
 * One device's volume, annotated under its node capsule next to its delay.
 *
 * The value is a share of the group's loudest device rather than an absolute
 * level: the engine scales each mirror by `own / loudest`, so 100 % means "as
 * the app produced it" and anything below attenuates that device. The loudest
 * device of a group therefore cannot be made louder, only the others quieter —
 * which is the whole point: one device (a headset, a weak speaker) is usually
 * too loud or too quiet next to the others.
 */
export function VolumeReadout({ deviceId, name }: { deviceId: string; name: string }) {
  const { t } = useTranslation();
  const committed = useRouterStore((s) => s.deviceVolumes[deviceId] ?? 100);
  const setDeviceVolume = useRouterStore((s) => s.setDeviceVolume);

  return (
    <ScrubReadout
      value={committed}
      min={0}
      max={100}
      step={VOLUME_STEP}
      pxPerStep={PX_PER_STEP}
      format={(value) => String(value)}
      unit="%"
      label={t('deviceVolume.valueLabel', { device: name })}
      hint={t('deviceVolume.hint', { step: VOLUME_STEP })}
      neutral={committed >= 100}
      onCommit={(next) => void setDeviceVolume(deviceId, next)}
    />
  );
}
