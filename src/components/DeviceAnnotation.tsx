import { Fragment, type ReactNode } from 'react';
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
 * The mark of the device Windows itself plays through.
 *
 * This is the safety anchor of the whole stage: whatever the user routes,
 * this is the device everything returns to, so it is named in words rather
 * than hinted at with a dot. It sits in the annotation row like a value but
 * is not one — no hover affordance, no accent, nothing to grab.
 */
function DefaultLabel() {
  const { t } = useTranslation();
  return (
    <span
      title={t('router.defaultDevice')}
      className="flex h-4 cursor-default items-center rounded-sm px-1 text-[10px] font-medium text-text-muted"
    >
      {t('router.defaultLabel')}
    </span>
  );
}

/**
 * The annotations hanging under one device node: its delay, its volume and
 * what it is playing at — plus the one label that is always welcome, the
 * "system default" mark.
 *
 * The values are owned by the parent DeviceNode, which subscribes to them
 * once; they are read here only to decide whether each annotation should show.
 * A value appears when the device is being worked with (selected) or when it
 * carries something that is actually being applied — the stage must never hide
 * an offset that is in effect, and must not shout about devices that are
 * neutral either.
 *
 * `showValues` is the advanced-controls switch: with it off the whole
 * delay/volume/latency row stays away, because a number a novice did not ask
 * for is a number they can drag by accident. The default-device mark ignores
 * the switch — knowing which device is safe is not an advanced feature.
 */
export function DeviceAnnotation({
  deviceId,
  name,
  rangeMs,
  isSelected,
  isDefault,
  showValues,
  engineRole,
  delay,
  volume,
  latency,
}: {
  deviceId: string;
  name: string;
  rangeMs: number;
  isSelected: boolean;
  /** Whether this is the system default device — the stage's safety anchor. */
  isDefault: boolean;
  /** Whether the expert readouts (delay / volume / latency) may show at all. */
  showValues: boolean;
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
  const showDelay = showValues && (isSelected || (delay ?? 0) !== 0);
  const showVolume = showValues && (isSelected || (volume ?? 100) !== 100);
  const showLatency = showValues && (isSelected || measured !== undefined);

  // The default mark trails the row rather than leading it: the readouts of
  // every device appear in the same place as the row grows, so the values stay
  // put under the capsule and the mark sits at the end like a qualifier —
  // leading with it would shove it out to the left the moment values appear.
  const items: ReactNode[] = [];
  if (showDelay) {
    items.push(
      <DelayReadout
        key="delay"
        deviceId={deviceId}
        name={name}
        rangeMs={rangeMs}
        engineRole={engineRole}
      />,
    );
  }
  if (showVolume) {
    items.push(
      <VolumeReadout key="volume" deviceId={deviceId} name={name} engineRole={engineRole} />,
    );
  }
  if (showLatency) {
    items.push(<LatencyReadout key="latency" latencyMs={measured} engineRole={engineRole} />);
  }
  if (isDefault) items.push(<DefaultLabel key="default" />);

  if (items.length === 0) return null;

  return (
    <div className="absolute left-1/2 top-full z-10 mt-1.5 flex -translate-x-1/2 items-center gap-1.5">
      {/* Stem: a hairline bridging the gap to the capsule, so the row reads as
          an annotation of that device rather than a stray label. */}
      <span
        aria-hidden="true"
        className="absolute -top-1.5 left-1/2 h-1.5 w-px -translate-x-1/2 bg-accent/30"
      />
      {items.map((node, index) =>
        index === 0 ? (
          node
        ) : (
          <Fragment key={index}>
            <span aria-hidden="true" className="h-2.5 w-px flex-none bg-border" />
            {node}
          </Fragment>
        ),
      )}
    </div>
  );
}
