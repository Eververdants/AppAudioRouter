import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CALL_TAIL_MS,
  LEAD_MIN_MS,
  LEAD_SPREAD_MS,
  MAX_ROUNDS,
  MIN_ROUNDS,
  MIN_VALID,
  TAP_EARLY_MS,
  TAP_LATE_MS,
} from '@/components/calibration/constants';
import { isStaleRunMessage, median, shuffled } from '@/components/calibration/measure';
import { mintRunToken } from '@/components/calibration/runToken';
import type { MeasureFailure, Step, ToneMarker } from '@/components/calibration/types';
import { useBackendEvent } from '@/hooks/useBackendEvent';
import { LATENCY_TARGET_MS } from '@/lib/delay';
import { calibrationCancel, calibrationStart } from '@/lib/invoke';
import type { AudioDevice } from '@/lib/types';
import { useRouterStore } from '@/stores/routerStore';

/**
 * The run itself: the round-robin loop, the taps it scores, the medians it
 * keeps, the baseline they are read against, and the write that hands the
 * numbers to the store.
 *
 * Rounds interleave the devices and one run answers one token, so everything
 * the loop touches lives here together: a measurement split across two files
 * would have a `runId` guard on one side of the seam and the thing it guards on
 * the other. The screens are the surface; this is the pipeline behind them, and
 * the state it holds is what they are allowed to show.
 */
export function useCalibrationRun({
  devices,
  selectedIds,
  onClose,
}: {
  /** The devices on the machine right now: the write skips the ones that left. */
  devices: AudioDevice[];
  /** The devices the selection screen has checked, read once at 开始测量. */
  selectedIds: string[];
  /** Closes the dialog once every device has taken its number. */
  onClose: () => void;
}) {
  const setDeviceDelayValue = useRouterStore((s) => s.setDeviceDelayValue);

  const [step, setStep] = useState<Step>('select');
  const [round, setRound] = useState(0);
  const [extending, setExtending] = useState(false);
  const [currentDevice, setCurrentDevice] = useState<string | null>(null);
  const [offsets, setOffsets] = useState<Record<string, number>>({});
  const [baselineId, setBaselineId] = useState<string | null>(null);
  /** Taps kept for the device being sampled, so a click visibly counts. */
  const [tapped, setTapped] = useState(0);
  const [sloppy, setSloppy] = useState(false);
  const [failure, setFailure] = useState<MeasureFailure | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyFailed, setApplyFailed] = useState(false);

  // The measurement runs across async boundaries (events, resolving
  // commands), so the mutable side lives in refs the callbacks can trust.
  const measuring = useRef(false);
  /** One token per run; an async loop bails once its token goes stale. */
  const runId = useRef(0);
  /** The same run's identity *as the backend knows it* — the `run` every start of
   *  this run is stamped with and every cancel of it names. 0 (the backend's
   *  `NO_RUN_TOKEN`) only while no run has been started. */
  const runToken = useRef(0);
  /** The devices this calibration session covers, fixed at 开始测量. */
  const selectedRef = useRef<string[]>([]);
  /** Valid per-burst offsets collected per device so far. */
  const repsRef = useRef<Record<string, number[]>>({});
  const currentDeviceRef = useRef<string | null>(null);
  /** When the burst being answered began, as the events report it. */
  const markerStart = useRef<number | null>(null);

  /**
   * Plays rounds until every session device has MIN_VALID presses or the cap
   * is hit, then hands the medians to the result screen.
   *
   * Rounds interleave the devices — a fresh shuffle each round, one burst per
   * device per round. Rounds past MIN_ROUNDS play only the devices still
   * short of presses. `restrict` re-runs a subset after a no-press failure
   * while keeping everyone else's readings.
   *
   * `myToken` is this run's backend identity — taken at the call, never read
   * back from the ref, because a newer run has already replaced it by the time a
   * stale loop wakes.
   */
  const runRounds = useCallback(
    async (myRun: number, myToken: number, restrict: string[] | null) => {
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
            // The burst that was sounding belongs to the device being left: a tap
            // that arrives during the next device's lead silence answers nothing,
            // and scoring it here would hand the previous device's timestamp to
            // this one as a measurement.
            markerStart.current = null;
            // A re-run keeps what a device already has; the tally on screen says
            // so rather than starting the count again under the user.
            setTapped(repsRef.current[id]?.length ?? 0);
            setSloppy(false);
            await calibrationStart(id, {
              reps: 1,
              leadMs: LEAD_MIN_MS + Math.floor(Math.random() * LEAD_SPREAD_MS),
              tailMs: CALL_TAIL_MS,
              run: myToken,
            });
            if (!alive()) {
              // The command landed *after* the wizard walked out. When the cancel
              // named this run — every one of them does — the player had already
              // refused the start that was still in flight, so this branch is the
              // rarer one: a burst admitted before the cancel reached the pump,
              // which then wrote out its schedule without seeing the flag. Ask once
              // more, and name the run: an *unnamed* cancel over an idle player is
              // read as an answer to the next start to arrive, and would eat the
              // following run's first burst.
              void calibrationCancel(myToken).catch(() => undefined);
              return;
            }
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
        // A stop the loop did not order (see `isStaleRunMessage`) is not a failure
        // to report — but returning here with the measure screen still up would
        // freeze the dialog on a burst that no longer sounds, so hand it back to
        // the selection screen, where 开始测量 is pressable again.
        const message = String(e);
        if (isStaleRunMessage(message)) {
          setStep('select');
          return;
        }
        setFailure({ message, noPresses: [] });
      } finally {
        if (alive()) measuring.current = false;
      }
    },
    [],
  );

  const beginMeasure = useCallback(() => {
    if (selectedIds.length < 2) return;
    runId.current += 1;
    // A run the backend has never seen: the token it is stamped with from here on
    // is what makes its own cancel precise.
    runToken.current = mintRunToken();
    selectedRef.current = selectedIds;
    repsRef.current = {};
    measuring.current = true;
    setFailure(null);
    setApplyFailed(false);
    setSloppy(false);
    setTapped(0);
    setOffsets({});
    setBaselineId(null);
    setStep('measure');
    void runRounds(runId.current, runToken.current, null);
  }, [selectedIds, runRounds]);

  /** Re-runs after a no-press failure: only the silent devices play again,
   *  everyone else's readings stay. */
  const retryNoPresses = useCallback(() => {
    const failed = failure?.noPresses ?? [];
    if (failed.length === 0) return;
    runId.current += 1;
    runToken.current = mintRunToken();
    measuring.current = true;
    setFailure(null);
    setSloppy(false);
    void runRounds(runId.current, runToken.current, failed);
  }, [failure, runRounds]);

  // Tone markers arrive while a command is in flight; a tap is scored against
  // the one the events placed. The handler reads refs, so the subscription
  // stays stable for the wizard's whole life.
  useBackendEvent<ToneMarker>('calibration-tone', (payload) => {
    if (!measuring.current) return;
    if (payload.phase === 'start') {
      markerStart.current = performance.now();
    }
  });

  const scoreTap = useCallback((tap: number) => {
    const device = currentDeviceRef.current;
    const start = markerStart.current;
    if (
      device === null ||
      start === null ||
      tap < start - TAP_EARLY_MS ||
      tap > start + TAP_LATE_MS
    ) {
      // The press answered no tone — early before one, or late past the window.
      // The burst is not spent by it: the tap that answers it still counts.
      setSloppy(true);
      return;
    }
    markerStart.current = null;
    setSloppy(false);
    const list = repsRef.current[device] ?? [];
    list.push(tap - start);
    repsRef.current = { ...repsRef.current, [device]: list };
    setTapped(list.length);
  }, []);

  const tap = useCallback(() => {
    if (!measuring.current) return;
    scoreTap(performance.now());
  }, [scoreTap]);

  const cancelRun = useCallback(() => {
    // Any in-flight loop goes stale at its next checkpoint and stands down.
    runId.current += 1;
    if (measuring.current) {
      measuring.current = false;
      // Named, so the player refuses the starts of *this* run only: an unnamed
      // cancel that finds no burst sounding marks the generation instead, and the
      // next run's first burst would be refused for a stop it had nothing to do
      // with.
      void calibrationCancel(runToken.current).catch(() => undefined);
    }
  }, []);

  // Leaving the wizard mid-run must not leave a burst playing into a dialog
  // nobody is listening to.
  useEffect(() => {
    return () => {
      runId.current += 1;
      if (measuring.current) void calibrationCancel(runToken.current).catch(() => undefined);
    };
  }, []);

  // Closing to tray does not unmount this dialog — React never tears a surface
  // down for a hidden window — so without this listener the short tones keep
  // playing into a window nobody can see, and the wizard stays frozen on a
  // measure screen nobody can answer. Stopping it the way the on-screen 取消
  // button does (cancel the run, back to the selection screen) leaves no burst
  // running and 开始测量 pressable when the window comes back. Only a live run
  // is worth stopping: the result screen and the idle selection screen hold no
  // sound. A refusal the backend raises on its own is caught in `runRounds`, so
  // the wizard is covered whether the hide is seen here or reported there.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'visible') return;
      if (!measuring.current) return;
      cancelRun();
      setStep('select');
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [cancelRun]);

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
        // A device that left since its own round cannot take a number: the
        // backend refuses it, and the refusal would stand forever — this screen
        // would have no way through, and the devices still here would never be
        // written. Every value is a difference against the baseline, so the rest
        // stay correct even when the baseline itself has gone.
        if (!devices.some((device) => device.id === deviceId)) continue;
        // The store never rejects — a refused value rolls back and logs — so
        // the boolean is the only failure signal here. Stop on the first one
        // and keep the results screen up to say so, instead of closing as if
        // every device had taken its number.
        if (!(await setDeviceDelayValue(deviceId, value))) {
          setApplyFailed(true);
          return;
        }
      }
      onClose();
    } catch {
      setApplyFailed(true);
    } finally {
      setApplying(false);
    }
  }, [computed, devices, onClose, setDeviceDelayValue]);

  return {
    step,
    setStep,
    round,
    extending,
    currentDevice,
    tapped,
    sloppy,
    failure,
    baselineId,
    setBaselineId,
    applyFailed,
    setApplyFailed,
    applying,
    computed,
    beginMeasure,
    retryNoPresses,
    tap,
    cancelRun,
    apply,
  };
}
