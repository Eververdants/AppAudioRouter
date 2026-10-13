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

/** Why the run stopped short of a result, when it did. */
interface MeasureFailure {
  /** The backend's complaint, when the run itself failed. */
  message: string | null;
  /** Devices that played through with no usable press; they get a re-run. */
  noPresses: string[];
}

/**
 * A press counts when the held duration matches the burst it was meant to
 * bracket; looser than this reads as a guess about when the tone began, and a
 * guess is exactly what the wizard exists to replace.
 */
const HOLD_TOLERANCE_MS = 250;

/** Valid presses a device needs before the wizard stops sampling it. */
const MIN_VALID = 3;

/** Rounds every selected device plays before the extension rounds begin. */
const MIN_ROUNDS = 3;

/** Hard cap on rounds per run, extensions included. */
const MAX_ROUNDS = 6;

/** Lead silence before a round-robin burst, drawn per call from this span.
 * The backend randomizes the gap within a run; drawing the lead per call
 * keeps the pace unpredictable across the whole session. */
const LEAD_MIN_MS = 300;
const LEAD_SPREAD_MS = 600;

/** Tail between round-robin calls. The pump paces its writes at the padding
 * target, so a burst is already audible when a schedule ends — a long tail
 * would only be dead time between calls. */
const CALL_TAIL_MS = 300;

/** Median of a non-empty list — the press the others agree with. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted[mid] ?? sorted[0] ?? 0;
}

/** Fisher–Yates on a copy: the round order rotates so no device is always
 * first, and reaction drift cannot settle on one of them. */
function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

/**
 * The delay wizard: measure each device's real, audible latency by playing
 * short tones and letting the user time them with a held button — press when
 * a tone is heard, release when it stops — then write the difference between
 * the slowest device and the rest as the copies' compensation.
 *
 * The devices interleave: the wizard drives one burst per call and rotates
 * through them round by round, so the human reaction time sits inside every
 * measurement equally and whatever drifts over the session (warming up,
 * tiring) lands on every device alike instead of biasing whichever was
 * measured first. Nothing about a device's type is guessed. The slowest
 * measured device becomes the alignment baseline (the role the engine
 * requires of the primary: the OS plays it directly, and software delay can
 * only hold the others back), and each other device receives
 * `difference − base pipeline` — the pipeline the copy would carry anyway.
 * Tapping a row re-picks the baseline: the offsets are all relative to each
 * other, so that is arithmetic, never a re-measure.
 */
export function DelayCalibration({
  devices,
  onClose,
}: {
  devices: AudioDevice[];
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const setDeviceDelayValue = useRouterStore((s) => s.setDeviceDelayValue);

  const [step, setStep] = useState<Step>('select');
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    // Devices that carry a live route are the ones that need aligning; they
    // start checked so the common case is a single press of the start button.
    const routed = new Set(Object.values(useRouterStore.getState().routedPids).flat());
    return devices.filter((d) => routed.has(d.id)).map((d) => d.id);
  });
  const [round, setRound] = useState(0);
  const [extending, setExtending] = useState(false);
  const [currentDevice, setCurrentDevice] = useState<string | null>(null);
  const [offsets, setOffsets] = useState<Record<string, number>>({});
  const [baselineId, setBaselineId] = useState<string | null>(null);
  const [holding, setHolding] = useState(false);
  const [sloppy, setSloppy] = useState(false);
  const [failure, setFailure] = useState<MeasureFailure | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyFailed, setApplyFailed] = useState(false);

  // The measurement runs across async boundaries (events, resolving
  // commands), so the mutable side lives in refs the callbacks can trust.
  const measuring = useRef(false);
  /** One token per run; an async loop bails once its token goes stale. */
  const runId = useRef(0);
  /** The devices this calibration session covers, fixed at 开始测量. */
  const selectedRef = useRef<string[]>([]);
  /** Valid per-burst offsets collected per device so far. */
  const repsRef = useRef<Record<string, number[]>>({});
  const currentDeviceRef = useRef<string | null>(null);
  const markerStart = useRef<number | null>(null);
  const markerEnd = useRef<number | null>(null);
  /** Counts bursts; a press that spans two bursts is discarded. */
  const markerSeq = useRef(0);
  const pressDown = useRef<number | null>(null);
  const pressSeq = useRef(0);

  const deviceName = useCallback(
    (id: string) => devices.find((d) => d.id === id)?.name ?? id,
    [devices],
  );

  const formatList = useCallback(
    (ids: string[]) =>
      new Intl.ListFormat(i18n.language, { type: 'unit' }).format(ids.map(deviceName)),
    [deviceName, i18n.language],
  );

  /**
   * Plays rounds until every session device has MIN_VALID presses or the cap
   * is hit, then hands the medians to the result screen.
   *
   * Rounds interleave the devices — a fresh shuffle each round, one burst per
   * device per round. Rounds past MIN_ROUNDS play only the devices still
   * short of presses. `restrict` re-runs a subset after a no-press failure
   * while keeping everyone else's readings.
   */
  const runRounds = useCallback(async (myRun: number, restrict: string[] | null) => {
    const alive = () => runId.current === myRun;
    try {
      for (let r = 0; r < MAX_ROUNDS; r += 1) {
        const isExtension = r >= MIN_ROUNDS;
        let batch = restrict ?? selectedRef.current;
        if (isExtension) {
          batch = batch.filter((id) => (repsRef.current[id]?.length ?? 0) < MIN_VALID);
          if (batch.length === 0) break;
        }
        setExtending(isExtension);
        setRound(r + 1);
        for (const id of shuffled(batch)) {
          if (!alive()) return;
          currentDeviceRef.current = id;
          setCurrentDevice(id);
          await calibrationStart(id, {
            reps: 1,
            leadMs: LEAD_MIN_MS + Math.floor(Math.random() * LEAD_SPREAD_MS),
            tailMs: CALL_TAIL_MS,
          });
          if (!alive()) return;
        }
      }
      if (!alive()) return;
      const noPresses = selectedRef.current.filter(
        (id) => (repsRef.current[id]?.length ?? 0) === 0,
      );
      if (noPresses.length > 0) {
        // The rounds played but some device heard no press worth keeping: let
        // the user retry just those devices rather than writing a number
        // nobody pressed for.
        setFailure({ message: null, noPresses });
        return;
      }
      const medians: Record<string, number> = {};
      let best = -Infinity;
      let baseline: string | null = null;
      for (const id of selectedRef.current) {
        const value = median(repsRef.current[id] ?? []);
        medians[id] = value;
        if (value > best) {
          best = value;
          baseline = id;
        }
      }
      setOffsets(medians);
      setBaselineId(baseline);
      setStep('result');
    } catch (e: unknown) {
      if (!alive()) return;
      // A cancel the wizard itself asked for is not a failure to report.
      if (String(e).includes('calibration cancelled')) return;
      setFailure({ message: String(e), noPresses: [] });
    } finally {
      if (alive()) measuring.current = false;
    }
  }, []);

  const beginMeasure = useCallback(() => {
    if (selectedIds.length < 2) return;
    runId.current += 1;
    selectedRef.current = selectedIds;
    repsRef.current = {};
    markerSeq.current = 0;
    measuring.current = true;
    setFailure(null);
    setApplyFailed(false);
    setSloppy(false);
    setOffsets({});
    setBaselineId(null);
    setStep('measure');
    void runRounds(runId.current, null);
  }, [selectedIds, runRounds]);

  /** Re-runs after a no-press failure: only the silent devices play again,
   *  everyone else's readings stay. */
  const retryNoPresses = useCallback(() => {
    const failed = failure?.noPresses ?? [];
    if (failed.length === 0) return;
    runId.current += 1;
    measuring.current = true;
    setFailure(null);
    setSloppy(false);
    void runRounds(runId.current, failed);
  }, [failure, runRounds]);

  // Tone markers arrive while a command is in flight; score completed presses
  // against them. The handler reads refs, so the subscription stays stable
  // for the wizard's whole life.
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
    const device = currentDeviceRef.current;
    const start = markerStart.current;
    const end = markerEnd.current;
    markerStart.current = null;
    markerEnd.current = null;
    if (device === null || start === null || end === null || seq !== markerSeq.current) {
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
    const list = repsRef.current[device] ?? [];
    list.push((down + up) / 2 - (start + end) / 2);
    repsRef.current = { ...repsRef.current, [device]: list };
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
    // Any in-flight loop goes stale at its next checkpoint and stands down.
    runId.current += 1;
    if (measuring.current) {
      measuring.current = false;
      void calibrationCancel().catch(() => undefined);
    }
  }, []);

  // Leaving the wizard mid-run must not leave a burst playing into a dialog
  // nobody is listening to.
  useEffect(() => {
    return () => {
      runId.current += 1;
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

  /**
   * The values the results screen shows, from the measured offsets.
   *
   * The baseline starts as the slowest measured device — the only seat the
   * engine can fully align to, since the OS plays it directly and software
   * delay can only hold the others back — but a tapped row re-picks it. The
   * baseline writes 0 (always the group's smallest, so the delay order can
   * never push another device onto the seat) and every other device writes
   * how much it has to be held back to meet it, minus the engine's base
   * pipeline — the lateness the copy would carry anyway. A device the
   * pipeline outruns — it measured within the pipeline's reach of the
   * baseline, or slower still — cannot be caught up: it writes 0 and the
   * result says how late it will stay.
   */
  const computed = (() => {
    if (baselineId === null || !(baselineId in offsets)) return null;
    const baseOffset = offsets[baselineId];
    if (baseOffset === undefined) return null;
    const values: Record<string, number> = { [baselineId]: 0 };
    const lagging: { id: string; diff: number; late: number }[] = [];
    for (const [id, offset] of Object.entries(offsets)) {
      if (id === baselineId) continue;
      const diff = Math.round(baseOffset - offset);
      const hold = diff - LATENCY_TARGET_MS;
      if (hold < 0) {
        lagging.push({ id, diff, late: LATENCY_TARGET_MS - diff });
        values[id] = 0;
      } else {
        values[id] = hold;
      }
    }
    return { values, lagging };
  })();

  const apply = useCallback(async () => {
    if (!computed) return;
    setApplying(true);
    try {
      // Write and nothing else: the calibration is the settings page touching
      // what belongs to each device, and a live route it leaves alone. The
      // baseline keeps the smallest value by construction (0, with every
      // other device clamped at 0 or above), so the delay order cannot
      // preview or land a different seat than the wizard assigned.
      for (const [deviceId, value] of Object.entries(computed.values)) {
        await setDeviceDelayValue(deviceId, value);
      }
      onClose();
    } catch {
      setApplyFailed(true);
    } finally {
      setApplying(false);
    }
  }, [computed, onClose, setDeviceDelayValue]);

  const toggleDevice = (id: string) => {
    setSelectedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
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
        )}

        {step === 'measure' && currentDevice !== null && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={FADE}>
            <p className="mt-2 text-[12px] text-text-secondary">
              {extending
                ? t('calibration.extensionRound', { r: round })
                : t('calibration.roundProgress', { r: round, n: MIN_ROUNDS })}
              {' · '}
              <span className="font-medium text-text-primary">
                {t('calibration.calibratingNow', { name: deviceName(currentDevice) })}
              </span>
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
                  {failure.message !== null
                    ? t('calibration.failed', { error: failure.message })
                    : t('calibration.noPresses', { devices: formatList(failure.noPresses) })}
                </p>
                <button
                  type="button"
                  onClick={failure.message !== null ? beginMeasure : retryNoPresses}
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

        {step === 'result' && computed !== null && baselineId !== null && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={FADE}>
            <p className="mt-2 text-[12px] leading-relaxed text-text-secondary">
              {t('calibration.baselineNote', { name: deviceName(baselineId) })}
            </p>
            <div className="mt-3">
              {Object.entries(computed.values).map(([id, value]) => (
                <button
                  key={id}
                  type="button"
                  disabled={id === baselineId}
                  onClick={() => setBaselineId(id)}
                  aria-pressed={id === baselineId}
                  className={`pressable flex w-full items-center justify-between gap-3 border-b border-line py-2 text-left outline-none last:border-b-0 focus-visible:ring-2 focus-visible:ring-accent/60 ${
                    id === baselineId
                      ? 'cursor-default text-text-primary'
                      : 'text-text-secondary hover:text-accent'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate text-xs">
                    {deviceName(id)}
                  </span>
                  <span className="flex-none text-[10.5px] text-text-muted">
                    {id === baselineId ? t('calibration.rolePrimary') : t('calibration.roleCopy')}
                  </span>
                  <span className="w-16 flex-none text-right font-mono text-[11px] tabular-nums text-text-primary">
                    {id === baselineId ? '—' : `+${value} ms`}
                  </span>
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-text-muted">
              {t('calibration.rebaseHint')}
            </p>
            {computed.lagging.map(({ id, diff, late }) => (
              <p
                key={id}
                className="mt-2 rounded-seg border border-line px-3 py-2 text-[11px] leading-relaxed text-text-secondary"
              >
                {diff < 0
                  ? t('calibration.laggingBehind', {
                      device: deviceName(id),
                      slow: -diff,
                      late,
                    })
                  : t('calibration.laggingClose', { device: deviceName(id), diff, late })}
              </p>
            ))}
            {applyFailed && (
              <p className="mt-2 text-[11px] leading-relaxed text-text-secondary">
                {t('calibration.applyFailed')}
              </p>
            )}
            <p className="mt-2 text-[11px] leading-relaxed text-text-muted">
              {t('calibration.finetune')}
            </p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={applying}
                onClick={beginMeasure}
                className="pressable rounded-ctl border border-line px-3 py-1.5 text-[11px] font-medium text-text-secondary outline-none hover:border-accent/50 hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-60"
              >
                {t('calibration.again')}
              </button>
              <button
                type="button"
                disabled={applying}
                onClick={() => void apply()}
                className="pressable flex items-center gap-1.5 rounded-ctl bg-accent px-3 py-1.5 text-[11px] font-medium text-accent-ink outline-none hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-60"
              >
                {applying && <Spinner size={11} />}
                {applying ? t('calibration.applying') : t('calibration.apply')}
              </button>
            </div>
          </motion.div>
        )}
      </motion.div>
    </div>
  );
}

/**
 * One device row of the selection screen: the name, and a picked word while
 * the row is selected. One flat question — which devices take part — with no
 * roles to decide up front; the measurement sorts that out by itself.
 */
function PickRow({
  label,
  picked,
  onToggle,
}: {
  label: string;
  picked: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={picked}
      className={`pressable flex w-full items-center justify-between gap-3 rounded-ctl border px-2.5 py-1.5 text-left text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-accent/60 ${
        picked
          ? 'border-accent bg-accent-muted text-accent'
          : 'border-line text-text-secondary hover:border-accent/50'
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {picked && <span className="flex-none text-[10px] text-accent">{t('calibration.picked')}</span>}
    </button>
  );
}
