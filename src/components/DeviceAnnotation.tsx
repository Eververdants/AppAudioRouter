import { useTranslation } from 'react-i18next';
import { DelayReadout } from '@/components/ui/DelayReadout';
import { VolumeReadout } from '@/components/ui/VolumeReadout';

/**
 * Whether (and how) a device's delay/volume values are currently applied.
 *
 * - `mirror`: the duplication engine drives this device, so its values take
 *   effect directly.
 * - `primary`: the system plays this device natively — software can neither
 *   delay nor attenuate that path, so its values only anchor the group.
 * - `inactive`: no engine path involves this device (unrouted, or the sole
 *   target of a single-device route), so its values do nothing right now.
 *
 * The role also decides whether a latency reading can exist at all: only a
 * mirror has a stream of ours to measure, so `primary` and `inactive` mean
 * "nothing to measure" rather than "0 ms".
 */
export type EngineRole = 'mirror' | 'primary' | 'inactive';

/**
 * What a mirrored device is really playing at, in milliseconds.
 *
 * A reading, not a control: the number is a fact about the running engine
 * rather than something the user sets, so it has no pointer handlers, no hover
 * underline and no accent — on this stage accent means "you can act on this".
 * It keeps the small unit and the tabular figures of the two editable readouts
 * beside it, which is what makes the three read as one annotation; the muted
 * colour and the absent underline are what keep it from being grabbed for a
 * drag.
 *
 * `undefined` is "not measured", which is not zero: with no engine driving the
 * device there is nothing to report, and a placeholder naming the reason beats
 * a number that looks measured.
 */
function LatencyReadout({ latencyMs, engineRole }: { latencyMs?: number; engineRole: EngineRole }) {
  const { t } = useTranslation();

  if (latencyMs === undefined) {
    return (
      <span
        // Three ways to have no number, and they are not the same thing: the
        // device Windows plays has no stream of ours to ask, a mirror whose
        // endpoint never reported one is a measurement that did not happen, and
        // a device no engine path touches is simply not part of a route. Saying
        // the last of those about a device that *is* being duplicated is the
        // opposite of the truth.
        title={t(
          engineRole === 'primary'
            ? 'deviceLatency.primary'
            : engineRole === 'mirror'
              ? 'deviceLatency.unmeasured'
              : 'deviceLatency.inactive',
        )}
        className="flex h-4 cursor-default items-center gap-px rounded-sm px-1 text-[10px] font-medium tabular-nums text-text-muted opacity-50"
      >
        <span>—</span>
        <span className="text-[8px] leading-none">ms</span>
      </span>
    );
  }

  return (
    <span
      title={t('deviceLatency.hint')}
      className="flex h-4 cursor-default items-center gap-px rounded-sm px-1 text-[10px] font-medium tabular-nums text-text-muted"
    >
      {latencyMs}
      <span className="text-[8px] leading-none">ms</span>
    </span>
  );
}

/**
 * The annotations hanging under one device node: its delay, its volume and
 * what it is playing at.
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
  engineRole,
  delay,
  volume,
  latency,
}: {
  deviceId: string;
  name: string;
  rangeMs: number;
  isSelected: boolean;
  engineRole: EngineRole;
  delay?: number;
  volume?: number;
  latency?: number;
}) {
  // The role is what makes a reading trustworthy: a measurement is only true
  // while an engine drives that device, so the store's map is read through it
  // and a number left behind by a route that has since stopped is dropped
  // rather than shown as if it were live. `mirror` is the only role with a
  // stream of ours to measure, which is also why the primary reads as "nothing
  // to measure" instead of as a zero.
  const measured = engineRole === 'mirror' ? latency : undefined;
  const showDelay = isSelected || (delay ?? 0) !== 0;
  const showVolume = isSelected || (volume ?? 100) !== 100;
  const showLatency = isSelected || measured !== undefined;

  if (!showDelay && !showVolume && !showLatency) return null;

  return (
    <div className="absolute left-1/2 top-full z-10 mt-1.5 flex -translate-x-1/2 items-center gap-1.5">
      {/* Stem: a hairline bridging the gap to the capsule, so the row reads as
          an annotation of that device rather than a stray label. */}
      <span
        aria-hidden="true"
        className="absolute -top-1.5 left-1/2 h-1.5 w-px -translate-x-1/2 bg-accent/30"
      />
      {showDelay && (
        <DelayReadout deviceId={deviceId} name={name} rangeMs={rangeMs} engineRole={engineRole} />
      )}
      {showDelay && showVolume && (
        <span aria-hidden="true" className="h-2.5 w-px flex-none bg-border" />
      )}
      {showVolume && <VolumeReadout deviceId={deviceId} name={name} engineRole={engineRole} />}
      {showVolume && showLatency && (
        <span aria-hidden="true" className="h-2.5 w-px flex-none bg-border" />
      )}
      {showLatency && <LatencyReadout latencyMs={measured} engineRole={engineRole} />}
    </div>
  );
}
