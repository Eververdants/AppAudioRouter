import type { SetRouterState } from './types';

// ---------------------------------------------------------------------------
// The store's module-level mutable state, in one place on purpose.
//
// Every value here is deliberately a *single* instance for the whole run:
// they are the concurrency guards the design rests on (AGENTS.md: no polling,
// one ask per exe, sweep-before-restore, one answer lands per reconciliation).
// Duplicating any of them — one per slice, one per module — silently
// reintroduces the races they exist to close, so they are exported from here
// and imported from there, never re-declared.
// ---------------------------------------------------------------------------

let logId = 0;
let errorId = 0;

/** The next log line's identity. A counter, not a timestamp: two lines in the
 * same second are still two lines. */
export function nextLogId(): number {
  return ++logId;
}

/** The next error notice's identity. Keyed on a counter, not on the text: the
 * same refusal happening twice is two notices, and the second one's countdown
 * starts on its own arrival. */
export function nextErrorId(): number {
  return ++errorId;
}

/**
 * One action, one card.
 *
 * A batch action can fail in several places at once — the tour's wipe meets
 * refused stops and stuck wires, and "stop all" meets one refusal per route.
 * Each `raiseError` replaces the notice before it and remounts the card (Toast
 * keys on the notice id), so one user action flickered through a stack of
 * complaints with only the last one left standing. Inside a batch, `raiseError`
 * collects instead: every message still writes its own error log the moment it
 * happens, and one card for all of them goes up when the action ends. Nesting is
 * by depth — the wipe wraps the batch stop it calls — so the card belongs to the
 * outermost action, and identical refusals are said once.
 */
let errorBatchDepth = 0;
const errorBatchMessages: string[] = [];

export function beginErrorBatch(): void {
  errorBatchDepth += 1;
}

/** Whether a batch is open right now — the seam `raiseError` reads to decide
 * between collecting and showing. */
export function isInErrorBatch(): boolean {
  return errorBatchDepth > 0;
}

/** Collect one message for the card the batch will raise when it ends. */
export function collectErrorMessage(message: string): void {
  errorBatchMessages.push(message);
}

/** Close one level of batch; the outermost one raises the collected card. */
export function endErrorBatch(set: SetRouterState): void {
  errorBatchDepth -= 1;
  if (errorBatchDepth > 0 || errorBatchMessages.length === 0) return;
  const message = [...new Set(errorBatchMessages)].join(' · ');
  errorBatchMessages.length = 0;
  set({ errorNotice: { id: nextErrorId(), message } });
}

/**
 * A refresh gate coalesces concurrent requests instead of dropping them: if a
 * refresh arrives while one is in flight, one more run is queued.
 */
interface RefreshGate {
  inFlight: boolean;
  rerun: boolean;
  rerunViaNotification: boolean;
}

export const deviceRefreshGate: RefreshGate = {
  inFlight: false,
  rerun: false,
  rerunViaNotification: false,
};
export const sessionRefreshGate: RefreshGate = {
  inFlight: false,
  rerun: false,
  rerunViaNotification: false,
};

export function queueRefresh(gate: RefreshGate, viaNotification: boolean): void {
  const rerunViaNotification = gate.rerun
    ? gate.rerunViaNotification && viaNotification
    : viaNotification;
  gate.rerun = true;
  gate.rerunViaNotification = rerunViaNotification;
}

export function runQueuedRefresh(gate: RefreshGate, run: (viaNotification: boolean) => void): void {
  if (!gate.rerun) return;
  const viaNotification = gate.rerunViaNotification;
  gate.rerun = false;
  gate.rerunViaNotification = false;
  run(viaNotification);
}

/**
 * PIDs this run already decided about, so a restore is attempted at most once
 * per process.
 *
 * Without it, a program the user stopped by hand would be put straight back on
 * the next refresh, and one whose restore failed would retry — and log — every
 * time Core Audio moved. Never pruned against the live list: a PID leaving it
 * is exactly the case that must not be retried.
 */
export const autoRestoreDecided = new Set<number>();

/**
 * Icon asks that have not settled yet, by executable name.
 *
 * One ask per exe at a time, ever: a program like an Electron game holds four
 * sessions of the same executable, and asking per session meant four
 * concurrent asks racing to write one map entry — a pid that died mid-ask
 * (which is exactly what Electron children do) settled `null` last and
 * clobbered the three good answers. The in-flight set also keeps a slow
 * extraction from being asked twice across refreshes.
 */
export const iconsInFlight = new Set<string>();

/**
 * Bounded second chances for a missed icon.
 *
 * The ask cadence is event-driven — a refresh, a hotplug — but a quiet system
 * never raises one, so the ask that lost its race (the pid died mid-question,
 * the shell lost an extraction once) would hold its letter tile for the whole
 * run: entering the app with nothing changing in the audio graph, some icons
 * simply never arrived. One timer per unresolved executable — 2s, 4s, 8s,
 * three tries — and the bookkeeping is gone the moment a data URL lands or
 * the executable leaves the list. Not a poll: once every miss is resolved or
 * spent there is nothing left to fire.
 */
export const iconRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
export const iconRetries = new Map<string, number>();
const ICON_RETRY_BASE_MS = 2000;
const ICON_RETRY_LIMIT = 3;

/** Rearm one executable's retry, unless a timer is pending or its tries are
 * spent. A later refresh that misses again arms from the remaining budget.
 *  `ask` is the caller's way back into the store — `loadMissingIcons` at the
 *  moment the timer fires, read from the live state, never a captured copy. */
export function scheduleIconRetry(exeName: string, ask: () => void): void {
  if (iconRetryTimers.has(exeName)) return;
  const used = iconRetries.get(exeName) ?? 0;
  if (used >= ICON_RETRY_LIMIT) return;
  iconRetries.set(exeName, used + 1);
  iconRetryTimers.set(
    exeName,
    setTimeout(
      () => {
        iconRetryTimers.delete(exeName);
        ask();
      },
      ICON_RETRY_BASE_MS * 2 ** used,
    ),
  );
}

/** A pending retry is moot: this pass is what it was waiting for. The spent
 * count survives — the timer firing into this pass is a retry, not a fresh
 * start, or a quiet system would loop at the base interval forever. */
export function clearIconTimer(exeName: string): void {
  const timer = iconRetryTimers.get(exeName);
  if (timer !== undefined) {
    clearTimeout(timer);
    iconRetryTimers.delete(exeName);
  }
}

/** A data URL is final, or the executable is gone: all of the bookkeeping
 * goes with it, so a returning process starts with a full retry budget. */
export function clearIconRetry(exeName: string): void {
  clearIconTimer(exeName);
  iconRetries.delete(exeName);
}

/**
 * Source PID + target exe pairs this run already decided about, so a feed
 * restore is attempted at most once per pair: a rule the user removed by hand
 * must not be put straight back, and one whose delivery failed must not retry —
 * and log — on every Core Audio move. Never pruned against the live list: a
 * PID leaving it is exactly the case that must not be retried.
 */
export const feedRestoreDecided = new Set<string>();

/**
 * The newest `reconcileActiveDuplications` ask, so only the last answer lands.
 *
 * Every path that changes an engine's life asks the backend which engines are
 * running — the AGENTS.md red line: one reconciliation follows such a path, the
 * all-rejected re-route included — and several of those asks can be in flight at
 * once.
 * Each reply is a picture of a moment that has already gone, so an older reply
 * that lands last writes the older device lists *and the older generation
 * numbers* over the current ones; every event the live engine then sends is
 * dropped by the generation guards, which is how a badge sticks on a route that
 * stopped and a mirror failure goes unnoticed.
 */
let reconcileFlight = 0;

/** Open one reconciliation ask and return its number. */
export function beginReconciliation(): number {
  return ++reconcileFlight;
}

/** Whether the answer to `flight` still pictures the newest ask. */
export function isCurrentReconciliation(flight: number): boolean {
  return flight === reconcileFlight;
}

/** Discard the reply of every reconciliation still in flight.
 *
 * `reconcileFlight` only compares reconciliations with each other, but a stop is a
 * mutation of the same picture: a reply asked for before it lands carries the
 * engine that has just been taken down, and writing that back would put the badge
 * and its generation on a route nothing is duplicating any more — which then
 * swallows every later event as a stale one. A stop therefore retires the
 * outstanding ask rather than asking again: stopping starts no engine, and the next
 * pass (a notification, the next route) re-reads the whole list anyway. Because the
 * engine only comes down when the backend answers, a stop retires the asks **twice**
 * — once against the picture the store still shows, once against the one its own
 * take-down provoked — and the two engine handlers retire the outstanding ask once,
 * since a route can end with nobody pressing anything and they have no answer of
 * their own to wait for. What the second retirement can throw away is a reading a
 * *different* route was owed, and an engine that starts asks for its own through
 * `duplication-ready`: a figure that waits is the cost, not a stopped route drawn as
 * playing. */
export function invalidateReconciliation(): void {
  reconcileFlight += 1;
}

/** Take back a route whose stop is still in the air, if a reconciliation answer put
 * it back on screen while the take-down was being processed.
 *
 * Retiring the outstanding asks cannot reach a reply that already committed, and
 * such a reply can only be one thing: the engine this stop is taking down, drawn as
 * running again — the badge and the generation of a route nothing is duplicating,
 * which then swallows every event of whatever route comes next. So a badge still
 * wearing the generation this stop retired goes back down with it, while a route the
 * user applied inside that window keeps its own, newer number: the backend hands
 * generations out monotonically, so two engines never share one. A route with no
 * engine (generation 0) is not in any answer to begin with, so there is nothing to
 * take back. */
export function retireStaleRevival(
  set: SetRouterState,
  pid: number,
  retiredGeneration: number,
): void {
  if (retiredGeneration <= 0) return;
  set((s) => {
    if (s.engineGenerations[pid] !== retiredGeneration) return {};
    const routedPids = { ...s.routedPids };
    delete routedPids[pid];
    const engineGenerations = { ...s.engineGenerations };
    delete engineGenerations[pid];
    return { routedPids, engineGenerations };
  });
}

/**
 * Everything that writes or clears an executable's endpoint assignment, one at
 * a time.
 *
 * The stale sweep and the two restore passes all touch the *same* record, and
 * the audio service keeps one assignment per executable — run them together and
 * the sweep can win, wiping a route the restore had just pinned, with nothing on
 * screen to explain the silence. They cannot be ordered at the call sites
 * either: each is triggered by whichever of the device list, the session list,
 * the memory or the carrier arrives last, and that order is not knowable. So
 * they queue here instead, and one queue gives the sweep-before-restore order
 * for free at every entry point, not only the one that remembered to ask.
 */
let assignmentQueue: Promise<void> = Promise.resolve();

/** Run `task` after whatever is already queued. Fire and forget: the caller has
 *  no answer to wait for, and a task that fails has already logged it. */
export function queueAssignmentWork(task: () => Promise<unknown>): void {
  const run = assignmentQueue.then(task);
  // Attaching the rejection handler here is also what keeps `run` itself from
  // surfacing as an unhandled rejection, and it is what stops one failing task
  // from closing the queue for the rest of the session.
  assignmentQueue = run.then(
    () => undefined,
    () => undefined,
  );
}
