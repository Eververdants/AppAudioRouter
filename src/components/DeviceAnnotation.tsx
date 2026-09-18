import { DelayReadout } from '@/components/ui/DelayReadout';
import { VolumeReadout } from '@/components/ui/VolumeReadout';

/**
 * The annotations hanging under one device node: its delay and its volume.
 *
 * The values are owned by the parent DeviceNode, which subscribes to them
 * once; they are read here only to decide whether each annotation should show.
 * A value appears when the device is being worked with (selected) or when it
 * carries something that is actually being applied — the stage must never hide
 * an offset that is in effect, and must not shout about devices that are
 * neutral either.
 */
export function DeviceAnnotation({
  deviceId,
  name,
  rangeMs,
  isSelected,
  delay,
  volume,
}: {
  deviceId: string;
  name: string;
  rangeMs: number;
  isSelected: boolean;
  delay?: number;
  volume?: number;
}) {
  const showDelay = isSelected || delay !== 0;
  const showVolume = isSelected || volume !== 100;

  if (!showDelay && !showVolume) return null;

  return (
    <div className="absolute left-1/2 top-full z-10 mt-1.5 flex -translate-x-1/2 items-center gap-1.5">
      {/* Stem: a hairline bridging the gap to the capsule, so the row reads as
          an annotation of that device rather than a stray label. */}
      <span
        aria-hidden="true"
        className="absolute -top-1.5 left-1/2 h-1.5 w-px -translate-x-1/2 bg-accent/30"
      />
      {showDelay && <DelayReadout deviceId={deviceId} name={name} rangeMs={rangeMs} />}
      {showDelay && showVolume && (
        <span aria-hidden="true" className="h-2.5 w-px flex-none bg-border" />
      )}
      {showVolume && <VolumeReadout deviceId={deviceId} name={name} />}
    </div>
  );
}
