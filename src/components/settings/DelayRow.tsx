import { DelayStepper } from '@/components/ui/DelayStepper';

/** A device row: name + the shared −/value/+ delay stepper. */
export function DelayRow({ deviceId, name }: { deviceId: string; name: string }) {
  return (
    <div className="flex items-center gap-3 border-b border-line py-2.5 last:border-b-0">
      <span className="min-w-0 flex-1 truncate text-xs text-text-secondary" title={name}>
        {name}
      </span>
      <DelayStepper deviceId={deviceId} name={name} />
    </div>
  );
}
