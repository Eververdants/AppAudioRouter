import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Spinner } from '@/components/ui/Spinner';
import { useBackendEvent } from '@/hooks/useBackendEvent';
import { LATENCY_TARGET_MS } from '@/lib/delay';
import { calibrationCancel, calibrationStart } from '@/lib/invoke';
import { FADE, MAIN_THREAD_TRANSFORM, SPRING_GLIDE, SPRING_TAP } from '@/lib/motion';
import { isEditableTarget } from '@/lib/productionGuards';
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
  /** Devices that played through with no usable tap; they get a re-run. */
  noPresses: string[];
}

/**
 * How close to the tone a tap has to land: this much anticipation before it and
 * this much of a slow reaction after it are still a person answering a sound.
 *
 * A tap is scored once, against the one burst that is sounding — the wizard
 * plays one at a time — so the window can be generous without admitting a press
 * that answers nothing. What it must not do is punish reaction time: the number
 * a device ends up with is its tap minus the tone's start, and the reaction that
 * sits inside it is the same for every device, so it cancels in every difference
 * the alignment is built from. The strict bracketing the held press needed
 * (match the burst's length or be discarded) is gone for exactly this reason:
 * two timings per tone is a dexterity test, and the second one adds nothing the
 * first does not already say.
 */
const TAP_EARLY_MS = 150;
const TAP_LATE_MS = 900;

/** Valid presses a device needs before the wizard stops sampling it. */
const MIN_VALID = 3;

/** Rounds every selected device plays before the extension rounds begin. */
const MIN_ROUNDS = 3;

/** Hard cap on rounds per run, extensions included. */
const MAX_ROUNDS = 6;

/** What `Tab` may land on inside the dialog, in DOM order.
 *  `aria-modal` hides the page behind this dialog from assistive tech, but it
 *  does nothing to the tab order: without a trap the walk simply continues into
 *  the settings page and the stage under it, and a timed measurement spent
 *  hunting for a control the dialog is covering is a burst not heard. */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Lead silence before a round-robin burst, drawn per call from this span.
 * The backend randomizes the gap within a run; drawing the lead per call
 * keeps the pace unpredictable across the whole session. */
const LEAD_MIN_MS = 300;
const LEAD_SPREAD_MS = 600;

/** Tail between round-robin calls. The pump paces its writes at the padding
 * target, so a burst is already audible when a schedule ends — a long tail
 * would only be dead time between calls. */
const CALL_TAIL_MS = 300;

/** localStorage key holding the highest run token this webview has handed out,
 * next to the aar-theme / aar-language / aar-delay-step keys. */
const RUN_TOKEN_STORAGE_KEY = 'aar-calibration-run';

/** The highest token minted so far by this page; see `mintRunToken`. */
let lastRunToken = 0;

/**
 * The `run` identity of one wizard run — the number both `calibration_start` and
 * `calibration_cancel` carry, and the only thing that tells the player's
 * `begin` which of its two callers arrived first.
 *
 * It has to answer to exactly one run, ever: the player outlives the page, so a
 * token reused by a *later* run — or by a page reloaded over a cancel mark the
 * earlier page left — would either refuse a burst the user never called off or
 * play one they did. `Date.now()` alone does not hold: two runs minted in the
 * same millisecond share a token, and a reload landing inside the previous
 * page's last millisecond hands that token straight back. So every token is the
 * previous one plus one, seeded from the wall clock and left in storage —
 * strictly increasing for this webview across reloads, and below
 * `Number.MAX_SAFE_INTEGER` (so well inside the backend's `u64`) for as long as
 * the epoch is measured in milliseconds.
 */
function mintRunToken(): number {
  let previous = lastRunToken;
  try {
    const stored = Number(localStorage.getItem(RUN_TOKEN_STORAGE_KEY));
    if (Number.isSafeInteger(stored) && stored > previous) previous = stored;
  } catch {
    /* storage may be unavailable; the wall-clock seed below still applies */
  }
  const next = Math.min(Number.MAX_SAFE_INTEGER, Math.max(previous, Date.now()) + 1);
  lastRunToken = next;
  try {
    localStorage.setItem(RUN_TOKEN_STORAGE_KEY, String(next));
  } catch {
    /* nothing to persist: within this page the counter already holds */
  }
  return next;
}

/** Median of a non-empty list — the press the others agree with. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted[mid] ?? sorted[0] ?? 0;
}

/**
 * A burst the backend stopped *under* the wizard rather than because this loop
 * asked it to: the window went invisible and its cancellation reached the run
 * before the loop did, or a newer generation refused this start outright.
 *
 * A stop the loop itself ordered never reaches the caller that reads this — it
 * bumps `runId` first, so the run is already stale and stands down at the guard
 * before it. So a message landing here while the loop is still the current one
 * is a run nobody in the wizard meant to end: it is not a measurement worth a
 * failure panel, but the dialog must not freeze on the measure screen either.
 * The two strings are the backend's own (`calibration.rs` answers a burst it
 * stopped mid-run with `"calibration cancelled"`, and `Refusal::Cancelled` — a
 * start whose run the user had already called off — with
 * `"calibration superseded (…)"`).
 */
function isStaleRunMessage(message: string): boolean {
  return message.includes('calibration cancelled') || message.includes('calibration superseded');
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
 * short tones and letting the user tap the button once for every tone heard,
 * then write the difference between the slowest device and the rest as the
 * copies' compensation.
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
  /** The dialog surface, so the keyboard lands inside a modal rather than
   *  behind it: the page under this is unreachable while it runs, and the walk
   *  is a timed one — every second spent hunting for the button is a burst not
   *  heard. */
  const dialogRef = useRef<HTMLDivElement | null>(null);
  /** The tap target, so the measurement screen starts with the key on it. */
  const tapRef = useRef<HTMLButtonElement | null>(null);

  // Every screen replaces the controls the focus was sitting on — 开始测量
  // unmounts, the failure panel and the tap button trade places — and a focused
  // element that leaves the DOM drops the caret to the document root, where the
  // next `Tab` walks straight out of a dialog that says `aria-modal`. So the
  // key is handed back to the dialog on each change of screen, and straight to
  // the tap button when a round is actually being answered (which is also what
  // makes `Space`/`Enter` tap, as the wizard promises).
  useEffect(() => {
    if (step === 'measure' && failure === null) tapRef.current?.focus();
    else dialogRef.current?.focus();
  }, [step, failure]);

  const deviceName = useCallback(
    (id: string) => devices.find((d) => d.id === id)?.name ?? t('calibration.deviceGone'),
    [devices, t],
  );

  const formatList = useCallback(
    (ids: string[]) =>
      new Intl.ListFormat(i18n.language, { type: 'unit' }).format(ids.map(deviceName)),
    [deviceName, i18n.language],
  );

  // A device unplugged while the wizard is open leaves its row, so it has to
  // leave the answer too: the two-device gate counts what is checked, and a
  // phantom in it would start a run that measures nothing and a result screen
  // that writes a number nothing can take. A run already going keeps the set it
  // started with — the baseline must not move under it.
  useEffect(() => {
    setSelectedIds((ids) => {
      const live = ids.filter((id) => devices.some((device) => device.id === id));
      return live.length === ids.length ? ids : live;
    });
  }, [devices]);

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

  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Escape belongs to the control holding the focus first — the wizard has
      // no field of its own, but focus can sit in one of the page's underneath
      // (a delay stepper's field, a control that owns the key via
      // `data-owns-escape`), and the capture phase below arrives before any of
      // them: standing down here is what leaves that press theirs.
      if (isEditableTarget(e.target)) return;
      e.stopPropagation();
      // Stop the walk *and* the sound: `cancelRun` is the only thing between a
      // burst and a dialog nobody can reach, and `onClose` unmounts this one —
      // whose cleanup names the run, so a `calibration_start` still on its way is
      // refused by the player instead of sounding into a dialog that is gone, and
      // the loop that awaited it reads the refusal where it is awaited.
      cancelRun();
      onClose();
    },
    [cancelRun, onClose],
  );

  // The tab trap. A dialog that declares `aria-modal` still has to hold the tab
  // order itself: the marker only tells assistive tech to ignore the rest of the
  // document, and `Tab` keeps walking through it. Registered while the dialog is
  // mounted and nowhere else, exactly like the Escape path beside it.
  const trapTab = useCallback((event: KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const container = dialogRef.current;
    if (container === null) return;
    const items = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (item) => item.getClientRects().length > 0,
    );
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) {
      // Nothing to walk: a screen with no control yet (the rows are still
      // arriving). Staying put is the honest answer, not letting the key out.
      event.preventDefault();
      container.focus();
      return;
    }
    const active = document.activeElement;
    const index = active instanceof HTMLElement ? items.indexOf(active) : -1;
    if (index === -1) {
      // The caret sits on the dialog surface itself, or has already slipped
      // behind it (an element under the pointer while it unmounted): pull it
      // back to the end or the start of the row it should have been on.
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    const atEdge = event.shiftKey ? index === 0 : index === items.length - 1;
    if (!atEdge) return;
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }, []);

  useEffect(() => {
    // The settings page stands down for Escape while this wizard is open (the
    // two sides change together); this listener is the only one that acts.
    // Capture phase, and the key is consumed: the toast's undo offer lives one
    // bubble-phase listener away, and a bubble-phase `stopPropagation` on the
    // same node cannot keep the key from it — only arriving first can.
    const onKey = (event: KeyboardEvent) => {
      trapTab(event);
      handleEscape(event);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [handleEscape, trapTab]);

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

  const toggleDevice = (id: string) => {
    setSelectedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 outline-none"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delay-calibration-title"
      ref={dialogRef}
      tabIndex={-1}
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
        )}

        {step === 'measure' && currentDevice !== null && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={FADE}
            transformTemplate={MAIN_THREAD_TRANSFORM}
          >
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
                  ref={tapRef}
                  type="button"
                  whileTap={{ scale: 0.985 }}
                  transition={SPRING_TAP}
                  transformTemplate={MAIN_THREAD_TRANSFORM}
                  onPointerDown={tap}
                  onKeyDown={(e) => {
                    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) tap();
                  }}
                  aria-label={t('calibration.tap')}
                  className="mt-4 flex h-20 w-full items-center justify-center rounded-ctl border border-line bg-surface-raised text-[13px] font-medium text-text-secondary outline-none hover:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent/60"
                >
                  {t('calibration.tap')}
                </motion.button>
                <p className="mt-2 text-[11px] leading-relaxed text-text-muted">
                  {t('calibration.tapTally', { n: tapped, need: MIN_VALID })}
                </p>
                {sloppy && (
                  <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
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
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={FADE}
            transformTemplate={MAIN_THREAD_TRANSFORM}
          >
            <p className="mt-2 text-[12px] leading-relaxed text-text-secondary">
              {t('calibration.baselineNote', { name: deviceName(baselineId) })}
            </p>
            <div className="mt-3">
              {Object.entries(computed.values).map(([id, value]) => (
                <button
                  key={id}
                  type="button"
                  // Inert while the write is in flight: the numbers going out
                  // were taken from this proposal, and a new baseline mid-write
                  // would leave the screen describing a set that was never sent.
                  disabled={id === baselineId || applying}
                  onClick={() => {
                    // The refusal described the numbers that were just sent; a
                    // different proposal makes it stale.
                    setApplyFailed(false);
                    setBaselineId(id);
                  }}
                  aria-pressed={id === baselineId}
                  className={`pressable flex w-full items-center justify-between gap-3 border-b border-line py-2 text-left outline-none last:border-b-0 focus-visible:ring-2 focus-visible:ring-accent/60 ${
                    id === baselineId
                      ? 'cursor-default text-text-primary'
                      : 'text-text-secondary hover:text-accent'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate text-xs">{deviceName(id)}</span>
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
      {picked && (
        <span className="flex-none text-[10px] text-accent">{t('calibration.picked')}</span>
      )}
    </button>
  );
}
