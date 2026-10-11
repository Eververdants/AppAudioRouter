import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Spinner } from '@/components/ui/Spinner';
import { useBackendEvent } from '@/hooks/useBackendEvent';
import { LATENCY_TARGET_MS } from '@/lib/delay';
import { calibrationCancel, calibrationStart } from '@/lib/invoke';
import { FADE, MAIN_THREAD_TRANSFORM, SPRING_GLIDE, SPRING_TAP } from '@/lib/motion';
import type { AudioDevice } from '@/lib/types';
import { useRouterStore } from '@/stores/routerStore';

/** The wizard's three screens, in order. */
type Step = 'select' | 'measure' | 'result';

/** Payload of the backend's `calibration-tone` events. */
interface ToneMarker {
  index: number;
  phase: 'start' | 'end';
}

/** Why the last device produced no value, when it did not. */
interface MeasureFailure {
  /** The backend's complaint, when the run itself failed. */
  message: string | null;
  /** True when the sequence played but no press was usable. */
  noPresses: boolean;
}

/**
 * A press counts when the held duration matches the burst it was meant to
 * bracket; looser than this reads as a guess about when the tone began, and a
 * guess is exactly what the wizard exists to replace.
 */
const HOLD_TOLERANCE_MS = 250;

/** Median of a non-empty list — the press the other two agree with. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted[mid] ?? sorted[0] ?? 0;
}

/**
 * The delay wizard: measure each device's real, audible latency by playing a
 * short tone and letting the user time it with a held button — press when the
 * tone is heard, release when it stops — then write the difference between the
 * slowest device and the rest as the copies' compensation.
 *
 * The human reaction time sits inside every measurement equally, so it cancels
 * in the differences; nothing about a device's type is guessed. The slowest
 * measured device becomes the alignment baseline (the role the engine requires
 * of the primary: the OS plays it directly, and software delay can only hold
 * the others back), and each other device receives
 * `difference − base pipeline` — the pipeline the copy would carry anyway.
 */
export function DelayCalibration({
  devices,
  onClose,
}: {
  devices: AudioDevice[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const setDeviceDelayValue = useRouterStore((s) => s.setDeviceDelayValue);

  const [step, setStep] = useState<Step>('select');
  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const [copyIds, setCopyIds] = useState<string[]>([]);
  /** Devices left to measure, in order: the chosen primary first. */
  const [queue, setQueue] = useState<string[]>([]);
  const [queueIndex, setQueueIndex] = useState(0);
  /** Valid per-burst offsets collected for the device being measured. */
  const [repCount, setRepCount] = useState(0);
  const [results, setResults] = useState<Record<string, number>>({});
  const [holding, setHolding] = useState(false);
  const [sloppy, setSloppy] = useState(false);
  const [failure, setFailure] = useState<MeasureFailure | null>(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);

  // The measurement runs across async boundaries (events, a resolving
  // command), so the mutable side lives in refs the callbacks can trust.
  const measuring = useRef(false);
  const repsRef = useRef<number[]>([]);
  const markerStart = useRef<number | null>(null);
  const markerEnd = useRef<number | null>(null);
  /** Counts bursts; a press that spans two bursts is discarded. */
  const markerSeq = useRef(0);
  const pressDown = useRef<number | null>(null);
  const pressSeq = useRef(0);
  const queueRef = useRef<string[]>([]);
  const queueIndexRef = useRef(0);
  const resultsRef = useRef<Record<string, number>>({});

  const deviceName = useCallback(
    (id: string) => devices.find((d) => d.id === id)?.name ?? id,
    [devices],
  );

  /** Kicks off the tone player for `deviceId` and wires its completion.
   *  Reaches itself through a ref: the sequence chains device to device. */
  const startDeviceRef = useRef<(deviceId: string) => void>(() => undefined);
  const startDevice = useCallback((deviceId: string) => {
    measuring.current = true;
    repsRef.current = [];
    markerStart.current = null;
    markerEnd.current = null;
    markerSeq.current = 0;
    setRepCount(0);
    setSloppy(false);
    setFailure(null);
    void calibrationStart(deviceId)
      .then(() => {
        // The sequence finished; the presses have been scored by the event
        // handlers as they landed.
        measuring.current = false;
        if (repsRef.current.length === 0) {
          // Three bursts and no usable press: let the user try the device
          // again rather than writing a number nobody pressed for.
          setFailure({ message: null, noPresses: true });
          return;
        }
        resultsRef.current = {
          ...resultsRef.current,
          [deviceId]: median(repsRef.current),
        };
        setResults(resultsRef.current);
        const nextIndex = queueIndexRef.current + 1;
        const next = queueRef.current[nextIndex];
        if (next !== undefined) {
          queueIndexRef.current = nextIndex;
          setQueueIndex(nextIndex);
          startDeviceRef.current(next);
        } else {
          setStep('result');
        }
      })
      .catch((e: unknown) => {
        measuring.current = false;
        // A cancel the wizard itself asked for is not a failure to report.
        if (String(e).includes('calibration cancelled')) return;
        setFailure({ message: String(e), noPresses: false });
      });
  }, []);
  // The indirection is read only from async continuations, never during
  // render, so keeping it fresh on every render is enough.
  startDeviceRef.current = startDevice;

  const beginMeasure = useCallback(
    (order: string[]) => {
      const first = order[0];
      if (first === undefined) return;
      queueRef.current = order;
      setQueue(order);
      queueIndexRef.current = 0;
      setQueueIndex(0);
      resultsRef.current = {};
      setResults({});
      setApplied(false);
      setStep('measure');
      startDevice(first);
    },
    [startDevice],
  );

  // Tone markers arrive while the command is in flight; score completed
  // presses against them. The handler reads refs, so the subscription stays
  // stable for the wizard's whole life.
  useBackendEvent<ToneMarker>('calibration-tone', (payload) => {
    if (!measuring.current) return;
    if (payload.phase === 'start') {
      markerStart.current = performance.now();
      markerSeq.current += 1;
    } else {
      markerEnd.current = performance.now();
    }
  });

  const scorePress = useCallback((down: number, up: number, seq: number) => {
    const start = markerStart.current;
    const end = markerEnd.current;
    markerStart.current = null;
    markerEnd.current = null;
    if (start === null || end === null || seq !== markerSeq.current) {
      // The press did not sit inside one burst (or missed it entirely).
      setSloppy(true);
      return;
    }
    const hold = up - down;
    const burst = end - start;
    if (Math.abs(hold - burst) > HOLD_TOLERANCE_MS) {
      setSloppy(true);
      return;
    }
    setSloppy(false);
    repsRef.current.push((down + up) / 2 - (start + end) / 2);
    setRepCount(repsRef.current.length);
  }, []);

  const beginPress = useCallback(() => {
    if (!measuring.current || pressDown.current !== null) return;
    pressDown.current = performance.now();
    pressSeq.current = markerSeq.current;
    setHolding(true);
  }, []);

  const endPress = useCallback(() => {
    const down = pressDown.current;
    if (down === null) return;
    pressDown.current = null;
    setHolding(false);
    scorePress(down, performance.now(), pressSeq.current);
  }, [scorePress]);

  const cancelRun = useCallback(() => {
    if (measuring.current) {
      measuring.current = false;
      void calibrationCancel().catch(() => undefined);
    }
  }, []);

  // Leaving the wizard mid-run must not leave a burst playing into a dialog
  // nobody is listening to.
  useEffect(() => {
    return () => {
      if (measuring.current) void calibrationCancel().catch(() => undefined);
    };
  }, []);

  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      cancelRun();
      onClose();
    },
    [cancelRun, onClose],
  );

  useEffect(() => {
    // The settings page stands down for Escape while this wizard is open (the
    // two sides change together); this listener is the only one that acts.
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [handleEscape]);

  /** The values the results screen shows, from the measured offsets. */
  const computed = (() => {
    const entries = Object.entries(results);
    if (entries.length === 0) return null;
    const baseline = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
    const values: Record<string, number> = { [baseline[0]]: 0 };
    for (const [id, offset] of entries) {
      if (id === baseline[0]) continue;
      values[id] = Math.max(0, Math.round(baseline[1] - offset) - LATENCY_TARGET_MS);
    }
    return { baselineId: baseline[0], values };
  })();

  const apply = useCallback(async () => {
    if (!computed) return;
    setApplying(true);
    try {
      // The baseline last: it ends at 0, which is the state the whole group's
      // arithmetic reads, and each copy's value lands before it.
      const entries = Object.entries(computed.values).sort(([a], [b]) =>
        a === computed.baselineId ? 1 : b === computed.baselineId ? -1 : 0,
      );
      for (const [deviceId, value] of entries) {
        await setDeviceDelayValue(deviceId, value);
      }
      setApplied(true);
    } finally {
      setApplying(false);
    }
  }, [computed, setDeviceDelayValue]);

  const device = queue[queueIndex];
  const toggleCopy = (id: string) => {
    setCopyIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delay-calibration-title"
    >
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={SPRING_GLIDE}
        transformTemplate={MAIN_THREAD_TRANSFORM}
        className="w-full max-w-md rounded-panel border border-line-strong bg-surface p-5"
      >
        <h2
          id="delay-calibration-title"
          className="text-[15px] font-semibold tracking-tight text-text-primary"
        >
          {t('calibration.title')}
        </h2>

        {step === 'select' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={FADE}>
            <p className="mt-2 text-[12px] leading-relaxed text-text-secondary">
              {t('calibration.intro')}
            </p>
            <div className="mt-4 max-h-[46vh] space-y-4 overflow-y-auto pr-1">
              <fieldset>
                <legend className="text-[11px] font-medium text-text-muted">
                  {t('calibration.pickPrimary')}
                </legend>
                <div className="mt-1.5 space-y-1">
                  {devices.map((d) => (
                    <PickRow
                      key={d.id}
                      label={d.name}
                      role={primaryId === d.id ? 'primary' : null}
                      onPick={() => {
                        setPrimaryId(d.id);
                        setCopyIds((ids) => ids.filter((x) => x !== d.id));
                      }}
                    />
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend className="text-[11px] font-medium text-text-muted">
                  {t('calibration.pickCopies')}
                </legend>
                <div className="mt-1.5 space-y-1">
                  {primaryId === null ? (
                    <p className="px-2.5 text-[11px] text-text-muted">
                      {t('calibration.pickPrimaryFirst')}
                    </p>
                  ) : (
                    devices
                      .filter((d) => d.id !== primaryId)
                      .map((d) => (
                        <PickRow
                          key={d.id}
                          label={d.name}
                          role={copyIds.includes(d.id) ? 'copy' : null}
                          onPick={() => toggleCopy(d.id)}
                        />
                      ))
                  )}
                </div>
              </fieldset>
            </div>
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
                disabled={primaryId === null || copyIds.length === 0}
                onClick={() => beginMeasure([primaryId as string, ...copyIds])}
                className="pressable flex items-center gap-1.5 rounded-ctl bg-accent px-3 py-1.5 text-[11px] font-medium text-accent-ink outline-none hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-60"
              >
                {t('calibration.start')}
              </button>
            </div>
          </motion.div>
        )}

        {step === 'measure' && device !== undefined && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={FADE}>
            <p className="mt-2 text-[12px] text-text-secondary">
              {t('calibration.deviceProgress', { i: queueIndex + 1, n: queue.length })}
              {' · '}
              <span className="font-medium text-text-primary">{deviceName(device)}</span>
            </p>
            <p className="mt-1 font-mono text-[11px] tabular-nums text-text-muted">
              {t('calibration.repProgress', { r: Math.min(repCount + 1, 3), n: 3 })}
            </p>

            {failure === null ? (
              <>
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.985 }}
                  transition={SPRING_TAP}
                  transformTemplate={MAIN_THREAD_TRANSFORM}
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId);
                    beginPress();
                  }}
                  onPointerUp={endPress}
                  onPointerCancel={endPress}
                  onKeyDown={(e) => {
                    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) beginPress();
                  }}
                  onKeyUp={(e) => {
                    if (e.key === ' ' || e.key === 'Enter') endPress();
                  }}
                  aria-label={holding ? t('calibration.holding') : t('calibration.hold')}
                  className={`mt-4 flex h-20 w-full items-center justify-center rounded-ctl border text-[13px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
                    holding
                      ? 'border-accent bg-accent-muted text-accent'
                      : 'border-line bg-surface-raised text-text-secondary hover:border-accent/50'
                  }`}
                >
                  {holding ? t('calibration.holding') : t('calibration.hold')}
                </motion.button>
                {sloppy && (
                  <p className="mt-2 text-[11px] leading-relaxed text-text-muted">
                    {t('calibration.sloppy')}
                  </p>
                )}
              </>
            ) : (
              <div className="mt-4 rounded-ctl border border-line px-3 py-2.5">
                <p className="text-[11px] leading-relaxed text-text-secondary">
                  {failure.noPresses
                    ? t('calibration.sloppyAll')
                    : t('calibration.failed', { error: failure.message ?? '' })}
                </p>
                <button
                  type="button"
                  onClick={() => startDevice(device)}
                  className="pressable mt-2 flex items-center gap-1.5 rounded-ctl border border-line px-2.5 py-1 text-[11px] font-medium text-text-secondary outline-none hover:border-accent/50 hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/60"
                >
                  {t('calibration.retry')}
                </button>
              </div>
            )}

            <div className="mt-5 flex items-center justify-end">
              <button
                type="button"
                onClick={() => {
                  cancelRun();
                  setStep('select');
                }}
                className="pressable rounded-ctl border border-line px-3 py-1.5 text-[11px] font-medium text-text-secondary outline-none hover:border-accent/50 hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                {t('calibration.cancel')}
              </button>
            </div>
          </motion.div>
        )}

        {step === 'result' && computed !== null && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={FADE}>
            <p className="mt-2 text-[12px] leading-relaxed text-text-secondary">
              {t('calibration.baselineNote', { name: deviceName(computed.baselineId) })}
            </p>
            <div className="mt-3">
              {Object.entries(computed.values).map(([id, value]) => (
                <div
                  key={id}
                  className="flex items-center justify-between gap-3 border-b border-line py-2 last:border-b-0"
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
                    {deviceName(id)}
                  </span>
                  <span className="flex-none text-[10.5px] text-text-muted">
                    {id === computed.baselineId
                      ? t('calibration.rolePrimary')
                      : t('calibration.roleCopy')}
                  </span>
                  <span className="w-16 flex-none text-right font-mono text-[11px] tabular-nums text-text-primary">
                    {id === computed.baselineId ? '—' : `+${value} ms`}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-text-muted">
              {t('calibration.finetune')}
            </p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={applying}
                onClick={() => beginMeasure(queueRef.current)}
                className="pressable rounded-ctl border border-line px-3 py-1.5 text-[11px] font-medium text-text-secondary outline-none hover:border-accent/50 hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-60"
              >
                {t('calibration.again')}
              </button>
              {applied ? (
                <button
                  type="button"
                  onClick={onClose}
                  autoFocus
                  className="pressable rounded-ctl bg-accent px-3 py-1.5 text-[11px] font-medium text-accent-ink outline-none hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent/60"
                >
                  {t('calibration.done')}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={applying}
                  onClick={() => void apply()}
                  className="pressable flex items-center gap-1.5 rounded-ctl bg-accent px-3 py-1.5 text-[11px] font-medium text-accent-ink outline-none hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-60"
                >
                  {applying && <Spinner size={11} />}
                  {applying ? t('calibration.applying') : t('calibration.apply')}
                </button>
              )}
            </div>
          </motion.div>
        )}
      </motion.div>
    </div>
  );
}

/**
 * One device row of the selection screen: the name, and the part this device
 * plays once picked — 基准 in the primary list, 副本 in the copies list. The
 * list a row sits in decides what picking it means, so the rows themselves
 * stay one honest question each.
 */
function PickRow({
  label,
  role,
  onPick,
}: {
  label: string;
  /** The role word shown while the row is picked, `null` when it is not. */
  role: 'primary' | 'copy' | null;
  onPick: () => void;
}) {
  const { t } = useTranslation();
  const roleWord =
    role === 'primary'
      ? t('calibration.pickPrimaryRole')
      : role === 'copy'
        ? t('calibration.pickCopyRole')
        : null;
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={role !== null}
      className={`pressable flex w-full items-center justify-between gap-3 rounded-ctl border px-2.5 py-1.5 text-left text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
        role !== null
          ? 'border-accent bg-accent-muted text-accent'
          : 'border-line text-text-secondary hover:border-accent/50'
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {roleWord !== null && <span className="flex-none text-[10px] text-accent">{roleWord}</span>}
    </button>
  );
}
