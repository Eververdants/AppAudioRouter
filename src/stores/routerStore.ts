import { create } from 'zustand';
import i18next from 'i18next';
import type {
  AudioChangedEvent,
  AudioDevice,
  AudioSession,
  DuplicationReadyEvent,
  DuplicationStoppedEvent,
  FeedCarrier,
  LogEntry,
  MirrorFailedEvent,
  RememberedRouteEntry,
  ReplacedRoute,
  ResetOutcome,
  SessionActivityEvent,
  StartupNotice,
  UndoSnapshot,
} from '@/lib/types';
import { currentLanguage } from '@/i18n';
import {
  DEFAULT_DELAY_RANGE_MS,
  DELAY_STEP_STORAGE_KEY,
  clampDelay,
  clampStep,
  orderByDelay,
  rangeSeconds,
  readDelayStep,
} from '@/lib/delay';
import { rgbaToDataUrl } from '@/lib/icons';
import * as api from '@/lib/invoke';

/** One executable's remembered feed rules: the programs its audio feeds into. */
export interface RememberedFeedEntry {
  sourceExe: string;
  targetExe: string[];
}

/** The inverse offer a feed change leaves standing. */
export interface FeedUndoOffer {
  sourcePid: number;
  targetPid: number;
  /** True when the change was an add (undo removes it); false for a removal. */
  added: boolean;
}

/** Where a feed rule stands right now.
 *
 * `live`: the carrier is configured and the source's render slot is free, so
 * sound is actually moving into the target. `suspended`: the source is routed
 * to a device — the per-app render slot belongs to that device, and the feed
 * comes back the moment the route stops. `no-carrier`: no endpoint pair is
 * configured, so the rule is recorded but nothing can move. */
export type FeedLiveness = 'live' | 'suspended' | 'no-carrier';

export function feedLiveness(
  sourcePid: number,
  carrier: FeedCarrier,
  routedPids: Record<number, string[]>,
): FeedLiveness {
  if (carrier.render === null || carrier.capture === null) return 'no-carrier';
  const routed = routedPids[sourcePid];
  return routed !== undefined && routed.length > 0 ? 'suspended' : 'live';
}

interface RouterState {
  devices: AudioDevice[];
  sessions: AudioSession[];
  /** Processes targeted by the current selection (Ctrl+click to multi-select). */
  selectedPids: number[];
  /** Devices targeted by the current selection — the plan's membership, in the
   * order the user built it. The route itself applies in delay order (see
   * `orderByDelay`), and that is the order the stage draws; among devices whose
   * delays tie this array's order is what stands, which is exactly the freedom
   * `promoteDevice` spends. */
  selectedDeviceIds: string[];
  /**
   * Whether `selectedDeviceIds` is still the app's own guess (the process's
   * live route, its remembered route, or the system default it already plays
   * through) rather than something the user picked. A guess is replaced by the
   * first device clicked, so choosing a device cannot silently keep the guessed
   * one playing alongside it.
   */
  deviceSelectionPrefilled: boolean;
  /** Devices each process is currently routed to, keyed by PID. */
  routedPids: Record<number, string[]>;
  /**
   * What each device is really playing at, in milliseconds, keyed by device id:
   * the pipeline the engine holds for that device plus the endpoint's own
   * reported stream latency. Only mirrors appear — Windows plays the primary
   * itself, so there is no stream of ours there to measure. Rebuilt from the
   * running engines on every reconciliation, so a device that stops being
   * mirrored loses its reading instead of keeping a stale one.
   */
  deviceLatencyMs: Record<string, number>;
  /**
   * System default render device. It is the endpoint a process plays through
   * until it gets an explicit route, so selecting a process falls back to it.
   */
  defaultDeviceId: string | null;
  /** Per-device delay compensation in milliseconds (signed). */
  deviceDelays: Record<string, number>;
  /** Largest magnitude a delay may be set to, in milliseconds. */
  delayRangeMs: number;
  /** How much one −/+ click changes a delay, in milliseconds. A UI preference
   * (persisted to localStorage, like the theme), not an engine setting. */
  delayStepMs: number;
  /** Per-device volume in percent (100 = the level the app produced). */
  deviceVolumes: Record<string, number>;
  /**
   * Per-program primary volume in percent, keyed by executable name — the
   * program's session volume, which is what its primary device plays at and
   * the one lever that reaches it. Running engines divide their mirrors' gain
   * by the same factor, so the copies are unaffected; 5 is the floor, because
   * a session volume of 0 is true silence no gain can undo. A missing entry is
   * the neutral 100, which is also what the backend stores as "no value".
   */
  primaryVolumes: Record<string, number>;
  /**
   * Which processes are rendering audio right now, keyed by PID.
   *
   * Seeded from the session list's `playing` flag on every refresh — the list
   * is the authority, so a process that left it stops sounding even if no
   * transition was observed — and kept current between refreshes by
   * `session-activity` events, which arrive the moment a session flips state
   * rather than when the next re-enumeration happens to run. This is display
   * state only: nothing in the routing logic reads it.
   */
  soundingPids: Record<number, boolean>;
  /**
   * The level this app applies to each program's audio on its way to the routed
   * devices, in percent, keyed by executable name — the same ownership rule the
   * routing assignments use, since one program can hold several sessions and the
   * level belongs to the program. 100 is the audio as the program produced it
   * and the middle of the range: below attenuates, above amplifies. A missing
   * entry is that neutral 100, which is also what the backend stores as "no
   * level".
   */
  sourceVolumes: Record<string, number>;
  /**
   * Each executable's icon as a data URL, keyed by executable name — the icon
   * belongs to the file, and one browser with a dozen processes has one icon.
   * Display state only: filled in after a refresh by asks that never block the
   * list, `null` meaning "asked, and there is none". Absent means "not asked
   * yet", which is the letter tile's cue.
   */
  iconByExe: Record<string, string | null>;
  /** Whether a route is written to the memory as it is applied, and restored
   * from it when the program plays again. */
  autoRemember: boolean;
  /** Routes the backend remembers, one entry per executable name. */
  rememberedRoutes: RememberedRouteEntry[];
  /**
   * "Send into" rules the backend remembers, one entry per source executable.
   * A rule is recorded even when it cannot be delivered yet — the node on the
   * board stays visible and says what is missing instead of vanishing.
   */
  rememberedFeeds: RememberedFeedEntry[];
  /**
   * Live feed targets keyed by source PID, in the order they were added.
   * Rebuilt from the memory and the live session list on every session refresh:
   * a feed pins endpoints on both ends, so a process leaving the list takes its
   * half of the wire with it.
   */
  feeds: Record<number, number[]>;
  /**
   * The endpoint pair that carries feeds (a loopback driver's render + capture
   * sides, configured in settings). Either half null means feeds are recorded
   * but nothing can move.
   */
  feedCarrier: FeedCarrier;
  /** Recording endpoints, for the carrier picker in settings. */
  captureDevices: AudioDevice[];
  /** The last feed change that can still be undone, while the offer stands. */
  feedUndo: FeedUndoOffer | null;
  /** Whether the close button hides the window to the tray instead of quitting. */
  closeToTray: boolean;
  /** Whether Windows starts this app at sign-in. */
  autostart: boolean;
  /** What the window says about this install: a welcome on a first run, or a
   * word about the assignments an earlier version may have left behind. Null
   * once acknowledged. */
  startupNotice: StartupNotice | null;
  logs: LogEntry[];
  /** True while a route request is in flight, so a rapid double-click cannot
   * dispatch two overlapping routes against the same selection. */
  applying: boolean;
  /** Generation counter per PID, incremented on each applyRoute/stopRoute so a
   * stale duplication-stopped event from a previous engine cannot clear the
   * state of a newer one. */
  engineGenerations: Record<number, number>;
  /** What the last route replaced, while the offer to put it back still stands.
   * Null when there is nothing to undo (nothing routed yet, or it was used,
   * waved away, or overtaken by a stop). */
  undoSnapshot: UndoSnapshot | null;

  // actions
  /** Pull the device list from the audio engine. `viaNotification` marks a refresh
   * the backend's change callbacks provoked: it only reaches the log when the list
   * really differs from what the UI already shows. */
  refreshDevices: (viaNotification?: boolean) => Promise<void>;
  /** Pull the process list, with the same logging rule as [`refreshDevices`]. */
  refreshSessions: (viaNotification?: boolean) => Promise<void>;
  /** Read the remembered routes the backend persisted for earlier sessions. */
  loadRememberedRoutes: () => Promise<void>;
  /** Put the remembered route of every process that has no route back on.
   * A no-op until the device list, the process list and the memory have all
   * arrived, which is why every one of them calls it. */
  restoreRememberedRoutes: () => Promise<void>;
  /** Forget one executable's remembered route. */
  forgetRememberedRoute: (exeName: string) => Promise<void>;
  /** Read the remembered feed rules and rebuild the live feed map from them. */
  loadFeeds: () => Promise<void>;
  /** Read the configured carrier pair (both halves may be null). */
  loadFeedCarrier: () => Promise<void>;
  /** Point the carrier at a new endpoint pair; pending feeds try to deliver. */
  setFeedCarrier: (render: string | null, capture: string | null) => Promise<void>;
  /** Read the recording endpoints for the carrier picker. */
  loadCaptureDevices: () => Promise<void>;
  /** Send one program's audio into another's input. Immediate (no hub apply):
   * the inverse offer rides the feed toast. */
  addFeed: (sourcePid: number, targetPid: number) => Promise<void>;
  /** Take one feed rule back. */
  removeFeed: (sourcePid: number, targetPid: number) => Promise<void>;
  /** Put every remembered feed whose two ends are live back on. Like the
   * device-route restore, it waits for the lists and the memory; whichever of
   * the three lands last calls it. */
  restoreRememberedFeeds: () => Promise<void>;
  /** Invert the last feed change without leaving a new offer. */
  undoFeed: () => Promise<void>;
  /** Drop the feed offer without acting on it. */
  dismissFeedUndo: () => void;
  /** Fold one Core Audio change notification into the UI: refresh whatever moved
   * and quietly, since the user did not ask for this. */
  syncFromNotification: (changed: AudioChangedEvent) => Promise<void>;
  loadDefaultDevice: () => Promise<void>;
  selectProcess: (pid: number) => void;
  toggleProcessSelection: (pid: number) => void;
  toggleDeviceSelection: (deviceId: string) => void;
  /** Move one staged device to the front of the plan — the seat the system
   * plays directly. A reorder of the plan and nothing else: membership belongs
   * to the disc toggle, no route moves until Apply, and the stage offers the
   * seat only where the apply's delay order would let the move stand. */
  promoteDevice: (deviceId: string) => void;
  toggleAutoRemember: () => void;
  /** Read the close-to-tray preference and the startup registry entry. */
  loadShellSettings: () => Promise<void>;
  /** Read what this install should be told about itself (first run / update). */
  loadStartupNotice: () => Promise<void>;
  /** Take the notice down and record that this version has run. */
  dismissStartupNotice: () => Promise<void>;
  toggleCloseToTray: () => Promise<void>;
  toggleAutostart: () => Promise<void>;
  /** Route one program to `deviceIds` and resolve with the generation of the
   * engine the backend started for it; rejects when the backend refused. The
   * single-PID seam the routing paths share — what a route means to the rest of
   * the state is written by the caller, which is the only side that knows
   * whether it is routing one program or a batch. */
  routeOne: (
    pid: number,
    exeName: string,
    deviceIds: string[],
    /** Whether the backend also writes this route to the memory. */
    remember: boolean,
  ) => Promise<number>;
  applyRoute: () => Promise<void>;
  /** Put back what the last route replaced: every program it took over returns
   * to the devices it was on, or to the system default when it was on none.
   * Consumes the offer, so it can only be run once. */
  undoLastRoute: () => Promise<void>;
  /** Drop the offer without acting on it (the toast timed out, Escape was
   * pressed, a new route replaced it, or the route was stopped by hand). */
  dismissUndo: () => void;
  stopRoute: (pid: number) => Promise<void>;
  stopAllRoutes: () => Promise<void>;
  /** Release the fixed output device of every program no live route is using.
   * The way out for programs an earlier version of this app left pinned. The
   * outcome is returned so the launch notice can report what it cleared. */
  resetPinnedEndpoints: () => Promise<ResetOutcome | null>;
  /** Release assignments whose program exited while it was routed, so its next
   * launch follows the system default again instead of the old device. */
  releaseStaleRoutes: () => Promise<void>;
  loadDelaySettings: () => Promise<void>;
  loadDeviceVolumes: () => Promise<void>;
  setDeviceVolume: (deviceId: string, percent: number) => Promise<void>;
  /** Read the stored per-program primary volumes. */
  loadPrimaryVolumes: () => Promise<void>;
  /** Set one program's primary volume (percent, 5–100, 100 = untouched). */
  setPrimaryVolume: (exeName: string, percent: number) => Promise<void>;
  /** Read the stored per-program levels the engines apply. */
  loadSourceVolumes: () => Promise<void>;
  /** Ask the backend for the icons the current process list is missing, one
   * command per executable, without waiting for them: the rows render their
   * letter tiles immediately and the icon lands whenever the shell is done.
   * A settled miss does not stick — it re-arms its own bounded timer (three
   * tries, doubling), because the likeliest failure (the process died
   * mid-ask) is one a later ask gets past and a quiet system never raises a
   * refresh to lean on; a success is final and never asked for again. */
  loadMissingIcons: () => void;
  /** Set one program's own level (percent, 0–400, 100 = unchanged). */
  setSourceVolume: (exeName: string, percent: number) => Promise<void>;
  /** Bring every routed program that is playing up to the loudest one's level,
   * in one action, and re-read the values that wrote. */
  alignSourceLevels: () => Promise<void>;
  setDeviceDelayValue: (deviceId: string, delayMs: number) => Promise<void>;
  setDelayRange: (rangeMs: number) => Promise<void>;
  setDelayStep: (stepMs: number) => void;
  handleDuplicationStopped: (event: DuplicationStoppedEvent) => void;
  /** One process began or stopped rendering audio. Display state for the
   * routing board; the routing logic never reads it. */
  handleSessionActivity: (event: SessionActivityEvent) => void;
  /** An engine has finished opening its mirror devices, so the latency it can
   *  report now exists. Re-reads it; there is no other moment to. */
  handleDuplicationReady: (event: DuplicationReadyEvent) => void;
  /** One mirror of a live route went quiet. The rest of the route keeps playing,
   * so only that device leaves the badge set — and the log says which one and why. */
  handleMirrorFailed: (event: MirrorFailedEvent) => void;
  /** Ask the backend which PIDs it is still duplicating — routes survive a
   *  restart — and reconcile the badges and the per-device latency readings with
   *  it. Runs at boot, and once whenever a route appears, so a fresh route needs
   *  no Core Audio change to be measured. */
  reconcileActiveDuplications: () => Promise<void>;
  addLog: (message: string, level?: LogEntry['level']) => void;
}

let logId = 0;

/**
 * A refresh gate coalesces concurrent requests instead of dropping them: if a
 * refresh arrives while one is in flight, one more run is queued.
 */
interface RefreshGate {
  inFlight: boolean;
  rerun: boolean;
  rerunViaNotification: boolean;
}

const deviceRefreshGate: RefreshGate = {
  inFlight: false,
  rerun: false,
  rerunViaNotification: false,
};
const sessionRefreshGate: RefreshGate = {
  inFlight: false,
  rerun: false,
  rerunViaNotification: false,
};

function queueRefresh(gate: RefreshGate, viaNotification: boolean): void {
  const rerunViaNotification = gate.rerun
    ? gate.rerunViaNotification && viaNotification
    : viaNotification;
  gate.rerun = true;
  gate.rerunViaNotification = rerunViaNotification;
}

function runQueuedRefresh(gate: RefreshGate, run: (viaNotification: boolean) => void): void {
  if (!gate.rerun) return;
  const viaNotification = gate.rerunViaNotification;
  gate.rerun = false;
  gate.rerunViaNotification = false;
  run(viaNotification);
}

/** The system default device as a route target, when it is still present. */
function defaultTargets(state: Pick<RouterState, 'devices' | 'defaultDeviceId'>): string[] {
  const id = state.defaultDeviceId;
  return id !== null && state.devices.some((d) => d.id === id) ? [id] : [];
}

/**
 * Identity of the device list, so a refresh that came from a Core Audio
 * notification can tell "the audio engine moved" apart from "what the screen
 * shows moved" — the first happens several times per hotplug, the second is the
 * only one worth a log line.
 */
function deviceSignature(devices: AudioDevice[]): string {
  return devices.map((d) => `${d.id}|${d.name}`).join('\n');
}

/** Same idea for the process list. `display_name` is deliberately left out:
 *  it belongs to the window, not the list, and a browser switching tabs would
 *  otherwise log "the process list changed" on every title change. */
function sessionSignature(sessions: AudioSession[]): string {
  return sessions.map((s) => `${s.pid}|${s.exe_name}`).join('\n');
}

/**
 * List order for the process panel: by executable name, then by PID for the
 * processes that share one.
 *
 * The backend hands the list back in the order the device walk produced it, so
 * it shuffles whenever any session anywhere comes or goes — rows jumped under
 * the cursor between two refreshes of an unchanged machine.
 */
function compareSessions(a: AudioSession, b: AudioSession): number {
  const byName = a.exe_name.localeCompare(b.exe_name, undefined, { sensitivity: 'base' });
  return byName !== 0 ? byName : a.pid - b.pid;
}

/** localStorage key holding the auto-remember switch, next to the other
 * webview-side preferences. */
const AUTO_REMEMBER_STORAGE_KEY = 'aar-auto-remember';

function readAutoRemember(): boolean {
  try {
    return localStorage.getItem(AUTO_REMEMBER_STORAGE_KEY) === '1';
  } catch {
    /* storage may be unavailable; the preference just does not persist */
    return false;
  }
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
const autoRestoreDecided = new Set<number>();

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
const iconsInFlight = new Set<string>();

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
const iconRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const iconRetries = new Map<string, number>();
const ICON_RETRY_BASE_MS = 2000;
const ICON_RETRY_LIMIT = 3;

/** Rearm one executable's retry, unless a timer is pending or its tries are
 * spent. A later refresh that misses again arms from the remaining budget. */
function scheduleIconRetry(exeName: string): void {
  if (iconRetryTimers.has(exeName)) return;
  const used = iconRetries.get(exeName) ?? 0;
  if (used >= ICON_RETRY_LIMIT) return;
  iconRetries.set(exeName, used + 1);
  iconRetryTimers.set(
    exeName,
    setTimeout(() => {
      iconRetryTimers.delete(exeName);
      useRouterStore.getState().loadMissingIcons();
    }, ICON_RETRY_BASE_MS * 2 ** used),
  );
}

/** A pending retry is moot: this pass is what it was waiting for. The spent
 * count survives — the timer firing into this pass is a retry, not a fresh
 * start, or a quiet system would loop at the base interval forever. */
function clearIconTimer(exeName: string): void {
  const timer = iconRetryTimers.get(exeName);
  if (timer !== undefined) {
    clearTimeout(timer);
    iconRetryTimers.delete(exeName);
  }
}

/** A data URL is final, or the executable is gone: all of the bookkeeping
 * goes with it, so a returning process starts with a full retry budget. */
function clearIconRetry(exeName: string): void {
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
const feedRestoreDecided = new Set<string>();

/**
 * Lowest live PID per executable name — the address a per-app assignment is
 * written to, since the audio service keeps them per executable and one browser
 * holds a dozen processes.
 */
function lowestPidByExe(sessions: AudioSession[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const session of sessions) {
    const key = session.exe_name.toLowerCase();
    const known = map.get(key);
    if (known === undefined || session.pid < known) map.set(key, session.pid);
  }
  return map;
}

/**
 * Rebuild the live feed map from the memory and the sessions: a rule exists on
 * the board only while both of its ends are on the list — a feed pins an
 * endpoint on each of them, so a process leaving the list takes its half of the
 * wire with it.
 */
function deriveFeeds(
  memory: RememberedFeedEntry[],
  sessions: AudioSession[],
): Record<number, number[]> {
  const pidByExe = lowestPidByExe(sessions);
  const feeds: Record<number, number[]> = {};
  for (const entry of memory) {
    const sourcePid = pidByExe.get(entry.sourceExe.toLowerCase());
    if (sourcePid === undefined) continue;
    for (const targetExe of entry.targetExe) {
      if (targetExe.toLowerCase() === entry.sourceExe.toLowerCase()) continue;
      const targetPid = pidByExe.get(targetExe.toLowerCase());
      if (targetPid === undefined) continue;
      const existing = feeds[sourcePid] ?? [];
      if (!existing.includes(targetPid)) existing.push(targetPid);
      feeds[sourcePid] = existing;
    }
  }
  return feeds;
}

/**
 * The feed memory with `sourceExe` pointing at `targetExe` (added) or without
 * it (removed). Matched case-insensitively, like the route memory; the first
 * spelling seen is the one kept.
 */
function rememberFeedTargets(
  entries: RememberedFeedEntry[],
  sourceExe: string,
  targetExe: string,
  added: boolean,
): RememberedFeedEntry[] {
  const key = sourceExe.toLowerCase();
  const existing = entries.find((entry) => entry.sourceExe.toLowerCase() === key);
  const others = entries.filter((entry) => entry.sourceExe.toLowerCase() !== key);
  if (!added) {
    const remaining = (existing?.targetExe ?? []).filter(
      (name) => name.toLowerCase() !== targetExe.toLowerCase(),
    );
    if (existing === undefined || remaining.length === 0) return others;
    return [...others, { sourceExe: existing.sourceExe, targetExe: remaining }];
  }
  const already = (existing?.targetExe ?? []).some(
    (name) => name.toLowerCase() === targetExe.toLowerCase(),
  );
  if (already) return entries;
  return [
    ...others,
    { sourceExe: existing?.sourceExe ?? sourceExe, targetExe: [...(existing?.targetExe ?? []), targetExe] },
  ];
}

/** A device's name for the log, or its id when it is not in the list. */
function deviceName(deviceId: string | undefined, devices: AudioDevice[]): string {
  if (deviceId === undefined) return '';
  return devices.find((device) => device.id === deviceId)?.name ?? deviceId;
}

/**
 * The targets remembered for an executable.
 *
 * Matched on the lowercased name: the memory is keyed by image name, and an
 * image name carries whatever case the launch used, so two launches of the same
 * program can differ in it.
 */
function rememberedFor(entries: RememberedRouteEntry[], exeName: string): string[] | undefined {
  const wanted = exeName.toLowerCase();
  return entries.find((entry) => entry.exeName.toLowerCase() === wanted)?.deviceIds;
}

/** The remembered list with every one of `exeNames` pointing at `deviceIds`. */
function rememberTargets(
  entries: RememberedRouteEntry[],
  exeNames: string[],
  deviceIds: string[],
): RememberedRouteEntry[] {
  const claimed = new Set(exeNames.map((name) => name.toLowerCase()));
  const next = entries.filter((entry) => !claimed.has(entry.exeName.toLowerCase()));
  for (const exeName of exeNames) next.push({ exeName, deviceIds: [...deviceIds] });
  return next;
}

/** One process whose remembered route is due to be put back. */
interface RestorableProcess {
  pid: number;
  exeName: string;
  deviceIds: string[];
}

/**
 * The processes a remembered route should be restored on.
 *
 * One per executable, lowest PID: the assignment Windows stores is per
 * executable, so a browser with a dozen processes needs one route rather than a
 * dozen engines duplicating the same audio. A target that has been unplugged
 * since is dropped, and a memory whose devices are all gone is left alone —
 * which is also what keeps the boot pass from misreading a device list that has
 * not arrived yet.
 */
function pickRestorable(
  sessions: AudioSession[],
  remembered: RememberedRouteEntry[],
  routedPids: Record<number, string[]>,
  devices: AudioDevice[],
): RestorableProcess[] {
  if (devices.length === 0) return [];
  const liveDeviceIds = new Set(devices.map((device) => device.id));
  const firstPidByExe = new Map<string, number>();
  for (const session of sessions) {
    const key = session.exe_name.toLowerCase();
    const known = firstPidByExe.get(key);
    if (known === undefined || session.pid < known) firstPidByExe.set(key, session.pid);
  }

  const targets: RestorableProcess[] = [];
  for (const session of sessions) {
    if (firstPidByExe.get(session.exe_name.toLowerCase()) !== session.pid) continue;
    if (autoRestoreDecided.has(session.pid)) continue;
    if (routedPids[session.pid] !== undefined) continue;
    const deviceIds = rememberedFor(remembered, session.exe_name)?.filter((id) =>
      liveDeviceIds.has(id),
    );
    if (deviceIds === undefined || deviceIds.length === 0) continue;
    targets.push({ pid: session.pid, exeName: session.exe_name, deviceIds });
  }
  return targets;
}

export const useRouterStore = create<RouterState>((set, get) => ({
  devices: [],
  sessions: [],
  selectedPids: [],
  selectedDeviceIds: [],
  deviceSelectionPrefilled: false,
  routedPids: {},
  deviceLatencyMs: {},
  defaultDeviceId: null,
  deviceDelays: {},
  delayRangeMs: DEFAULT_DELAY_RANGE_MS,
  delayStepMs: readDelayStep(),
  deviceVolumes: {},
  primaryVolumes: {},
  sourceVolumes: {},
  iconByExe: {},
  soundingPids: {},
  autoRemember: readAutoRemember(),
  rememberedRoutes: [],
  rememberedFeeds: [],
  feeds: {},
  feedCarrier: { render: null, capture: null },
  captureDevices: [],
  feedUndo: null,
  closeToTray: false,
  autostart: false,
  startupNotice: null,
  logs: [],
  applying: false,
  engineGenerations: {},
  undoSnapshot: null,

  refreshDevices: async (viaNotification = false) => {
    if (deviceRefreshGate.inFlight) {
      queueRefresh(deviceRefreshGate, viaNotification);
      return;
    }
    deviceRefreshGate.inFlight = true;
    try {
      const devices = await api.listDevices();
      const liveIds = new Set(devices.map((d) => d.id));
      const unchanged = deviceSignature(devices) === deviceSignature(get().devices);
      // One commit, not two: the new list and what it implies for the routes
      // arrive together. Published apart, there is a render in which the
      // devices are the new ones while a route still names one that is gone —
      // an unroutable badge, drawn for no longer than it takes to notice.
      //
      // A physically-routed device may have been unplugged. Drop it from the
      // selection and from any route that referenced it; a route left pointing
      // at a gone device is silently unroutable and confuses the badges.
      set((s) => {
        const selectedDeviceIds = s.selectedDeviceIds.filter((id) => liveIds.has(id));
        const routedPids: Record<number, string[]> = {};
        const engineGenerations = { ...s.engineGenerations };
        for (const [pid, ids] of Object.entries(s.routedPids)) {
          const numericPid = Number(pid);
          const remaining = ids.filter((id) => liveIds.has(id));
          if (remaining.length > 0) routedPids[numericPid] = remaining;
          else delete engineGenerations[numericPid];
        }
        return { devices, selectedDeviceIds, routedPids, engineGenerations };
      });
      // The device list is one of the three inputs a restore needs, and at boot
      // it is just as likely to be the last of them to arrive.
      void get().restoreRememberedRoutes();
      // Nothing on screen moved, so a notification gets no line at all.
      if (viaNotification && unchanged) return;
      get().addLog(
        viaNotification
          ? i18next.t('log.devicesChanged', { n: devices.length })
          : i18next.t('log.deviceRefreshed', { n: devices.length }),
        'info',
      );
    } catch (e) {
      get().addLog(i18next.t('log.deviceRefreshFailed', { error: String(e) }), 'error');
    } finally {
      deviceRefreshGate.inFlight = false;
      runQueuedRefresh(deviceRefreshGate, (rerunViaNotification) => {
        void get().refreshDevices(rerunViaNotification);
      });
    }
  },

  refreshSessions: async (viaNotification = false) => {
    if (sessionRefreshGate.inFlight) {
      queueRefresh(sessionRefreshGate, viaNotification);
      return;
    }
    sessionRefreshGate.inFlight = true;
    try {
      const sessions = (await api.listSessions()).sort(compareSessions);
      const livePids = new Set(sessions.map((s) => s.pid));
      const unchanged = sessionSignature(sessions) === sessionSignature(get().sessions);
      const routedBefore = Object.keys(get().routedPids).map(Number);
      set((s) => {
        // A single-device route has no duplication engine to report its end, so
        // the session list is the authoritative signal that its PID is gone.
        const routedPids: Record<number, string[]> = {};
        for (const [pid, ids] of Object.entries(s.routedPids)) {
          const numericPid = Number(pid);
          if (livePids.has(numericPid)) routedPids[numericPid] = ids;
        }
        const selectedPids = s.selectedPids.filter((pid) => livePids.has(pid));
        const engineGenerations: Record<number, number> = {};
        for (const [pid, generation] of Object.entries(s.engineGenerations)) {
          const numericPid = Number(pid);
          if (livePids.has(numericPid)) engineGenerations[numericPid] = generation;
        }
        // Rebuilt rather than merged: the list is the authority on who is
        // sounding, so a process that left it stops sounding even if its
        // Inactive transition was never observed. The session-activity events
        // keep this current between refreshes, the moment a session flips.
        const soundingPids: Record<number, boolean> = {};
        for (const session of sessions) {
          if (session.playing === true) soundingPids[session.pid] = true;
        }
        // Feeds pin an endpoint on each end, so both ends have to be live for
        // the wire to stay on the board — rebuilt from the memory, same as the
        // badges above are rebuilt from the engine list.
        const feeds = deriveFeeds(s.rememberedFeeds, sessions);
        return {
          sessions,
          routedPids,
          selectedPids,
          selectedDeviceIds: selectedPids.length === 0 ? [] : s.selectedDeviceIds,
          engineGenerations,
          soundingPids,
          feeds,
        };
      });
      // A routed program can exit on its own, and the fixed output device
      // Windows took then outlives it: the next launch would play to the old
      // device and ignore the system default, with no route on screen to explain
      // it. Ask the backend to hand that assignment to the program's next
      // process instead of leaving it behind.
      //
      // The sweep and the restore below are ordered rather than concurrent: both
      // can touch the same executable's assignment — the sweep through the
      // program's new process, the restore by writing one — and run together the
      // sweep can win and undo a route that was just applied.
      const swept = routedBefore.some((pid) => !livePids.has(pid))
        ? get().releaseStaleRoutes()
        : Promise.resolve();
      // A program that has just started playing is the moment its remembered
      // route is due; the same pass picks up everything that was already running
      // when the app launched. Feeds ride the same ordering — both passes can
      // pin endpoints around one executable.
      void swept.then(() => get().restoreRememberedRoutes());
      void swept.then(() => get().restoreRememberedFeeds());
      // Icons ride behind the list, never in front of it: the rows are already
      // on screen with their letter tiles by the time the shell answers.
      get().loadMissingIcons();
      if (viaNotification && unchanged) return;
      get().addLog(
        viaNotification
          ? i18next.t('log.sessionsChanged', { n: sessions.length })
          : i18next.t('log.sessionsRefreshed', { n: sessions.length }),
        'info',
      );
    } catch (e) {
      get().addLog(i18next.t('log.sessionsRefreshFailed', { error: String(e) }), 'error');
    } finally {
      sessionRefreshGate.inFlight = false;
      runQueuedRefresh(sessionRefreshGate, (rerunViaNotification) => {
        void get().refreshSessions(rerunViaNotification);
      });
    }
  },

  syncFromNotification: async ({ devices, sessions }) => {
    if (devices) {
      // The system default is what an unrouted process falls back to, and it is
      // exactly what unplugging the current output tends to move.
      await get().refreshDevices(true);
      // The carrier picker lists the capture flow too: a loopback driver
      // installed a minute ago must show up here without an app restart, or
      // the settings page cannot pair it right after the install.
      await get().loadCaptureDevices();
      await get().loadDefaultDevice();
    }
    if (sessions) await get().refreshSessions(true);
    // Anything the lists just noticed can change which engines are running and
    // therefore what their devices are playing at, and this is the refresh the
    // latency reading would otherwise never get: it is not tied to a route
    // action, and nothing else asks the engines again.
    await get().reconcileActiveDuplications();
  },

  loadDefaultDevice: async () => {
    try {
      const device = await api.getDefaultDevice();
      set({ defaultDeviceId: device.id });
    } catch (e) {
      get().addLog(i18next.t('log.defaultDeviceFailed', { error: String(e) }), 'error');
    }
  },

  selectProcess: (pid) =>
    set((s) => ({
      // Single selection starts fresh from that process's active targets, or
      // from the system default endpoint it already plays through.
      selectedPids: [pid],
      selectedDeviceIds: s.routedPids[pid] ?? defaultTargets(s),
      // Whatever came out of that is a guess about where the process plays, not
      // something the user asked for yet.
      deviceSelectionPrefilled: true,
    })),

  toggleProcessSelection: (pid) =>
    set((s) => {
      const selectedPids = s.selectedPids.includes(pid)
        ? s.selectedPids.filter((p) => p !== pid)
        : [...s.selectedPids, pid];
      // Device targets stay shared across a multi-selection; clear them only
      // when the last process was deselected. Either way the target list is no
      // longer one process's prefilled guess.
      const selectedDeviceIds = selectedPids.length === 0 ? [] : s.selectedDeviceIds;
      return { selectedPids, selectedDeviceIds, deviceSelectionPrefilled: false };
    }),

  toggleDeviceSelection: (deviceId) => {
    const { selectedDeviceIds, deviceSelectionPrefilled, devices, selectedPids, sessions } = get();
    // The first click on a device while the target list is still the app's own
    // single-device guess *replaces* it: "play through that one instead". Adding
    // to the guess is what used to turn a device switch into a second copy of
    // the audio on a device the user did not mean to use.
    const replacesGuess =
      deviceSelectionPrefilled &&
      selectedDeviceIds.length === 1 &&
      !selectedDeviceIds.includes(deviceId);
    const next = replacesGuess
      ? [deviceId]
      : selectedDeviceIds.includes(deviceId)
        ? selectedDeviceIds.filter((id) => id !== deviceId)
        : [...selectedDeviceIds, deviceId];
    set({ selectedDeviceIds: next, deviceSelectionPrefilled: false });
    if (replacesGuess) {
      const device = devices.find((d) => d.id === deviceId)?.name ?? deviceId;
      const process = sessions.find((s) => s.pid === selectedPids[0])?.exe_name;
      get().addLog(
        process === undefined
          ? i18next.t('log.deviceSwitched', { device })
          : i18next.t('log.deviceSwitchedProcess', { process, device }),
        'info',
      );
    }
  },

  promoteDevice: (deviceId) => {
    const { selectedDeviceIds } = get();
    // Not staged, or already the primary: nothing to move. A no-op must not
    // churn the array the stage's role words are keyed against.
    const index = selectedDeviceIds.indexOf(deviceId);
    if (index <= 0) return;
    set({
      selectedDeviceIds: [deviceId, ...selectedDeviceIds.filter((id) => id !== deviceId)],
    });
  },

  toggleAutoRemember: () => {
    const next = !get().autoRemember;
    set({ autoRemember: next });
    try {
      localStorage.setItem(AUTO_REMEMBER_STORAGE_KEY, next ? '1' : '0');
    } catch {
      /* storage may be unavailable; the preference just does not persist */
    }
    // Turning it on asks for the routes that are already remembered, not for a
    // promise about the next time something happens to move in the audio graph.
    if (next) void get().restoreRememberedRoutes();
  },

  loadRememberedRoutes: async () => {
    try {
      const routes = await api.getRememberedRoutes();
      set({
        rememberedRoutes: routes.map(([exeName, deviceIds]) => ({ exeName, deviceIds })),
      });
    } catch (e) {
      get().addLog(i18next.t('log.rememberedRoutesFailed', { error: String(e) }), 'error');
      return;
    }
    // The device list, the process list and the memory arrive in no particular
    // order, and a restore needs all three — so whichever lands last is the one
    // that can actually do something, and each of them asks.
    void get().restoreRememberedRoutes();
  },

  restoreRememberedRoutes: async () => {
    const {
      autoRemember,
      applying,
      rememberedRoutes,
      routedPids,
      devices,
      deviceDelays,
      sessions,
    } = get();
    if (!autoRemember || rememberedRoutes.length === 0) return;
    // A route the user is applying right now already owns these processes.
    // Nothing is claimed here, so the next pass picks them up again.
    if (applying) return;
    const targets = pickRestorable(sessions, rememberedRoutes, routedPids, devices);
    if (targets.length === 0) return;
    // Claimed before the first await: a refresh landing while these are in
    // flight must not start a second engine for the same process.
    for (const target of targets) autoRestoreDecided.add(target.pid);

    const results = await Promise.allSettled(
      targets.map(async (target) => {
        // Delay order, exactly as a manual route applies it: the earliest device
        // is the one the OS plays natively and the reference every copy is held
        // back from. Not re-remembered — it came out of the memory.
        const ordered = orderByDelay(target.deviceIds, deviceDelays);
        const generation = await api.applyRoute(target.pid, target.exeName, ordered, false);
        return { target, ordered, generation };
      }),
    );

    const restored: Record<number, string[]> = {};
    const generations: Record<number, number> = {};
    results.forEach((result, index) => {
      const target = targets[index];
      if (result.status === 'fulfilled') {
        const { ordered, generation } = result.value;
        if (target === undefined) return;
        restored[target.pid] = [...ordered];
        generations[target.pid] = generation;
        const copies = ordered.length - 1;
        get().addLog(
          i18next.t(copies > 0 ? 'log.routeRestoredMulti' : 'log.routeRestored', {
            process: target.exeName,
            device: deviceName(ordered[0], devices),
            m: copies,
          }),
          'info',
        );
      } else {
        // Left claimed: retrying on every refresh would fill the log with the
        // same failure, and the program can still be routed by hand.
        get().addLog(
          i18next.t('log.routeRestoreFailed', {
            process: target?.exeName ?? '',
            error: String(result.reason),
          }),
          'error',
        );
      }
    });
    if (Object.keys(restored).length === 0) return;
    set((s) => ({
      routedPids: { ...s.routedPids, ...restored },
      engineGenerations: { ...s.engineGenerations, ...generations },
    }));
    // A restored route starts an engine just like a manual one, and the boot
    // reconciliation ran alongside this pass rather than after it — so without
    // this, routes restored at launch would carry no reading until the user
    // happened to apply something by hand.
    await get().reconcileActiveDuplications();
  },

  forgetRememberedRoute: async (exeName) => {
    const previous = get().rememberedRoutes;
    set({ rememberedRoutes: previous.filter((entry) => entry.exeName !== exeName) });
    try {
      await api.clearRoute(exeName);
      get().addLog(i18next.t('log.rememberedRouteCleared', { process: exeName }), 'info');
    } catch (e) {
      // The file still carries it, so the list must too: showing a route as
      // forgotten while the next launch restores it is the worse lie.
      set({ rememberedRoutes: previous });
      get().addLog(
        i18next.t('log.rememberedRouteClearedFailed', { process: exeName, error: String(e) }),
        'error',
      );
    }
  },

  loadFeeds: async () => {
    try {
      const pairs = await api.listFeeds();
      const grouped = new Map<string, { sourceExe: string; targetExe: string[] }>();
      for (const [sourceExe, targetExe] of pairs) {
        const key = sourceExe.toLowerCase();
        const entry = grouped.get(key);
        if (entry === undefined) grouped.set(key, { sourceExe, targetExe: [targetExe] });
        else entry.targetExe.push(targetExe);
      }
      const rememberedFeeds = [...grouped.values()];
      set({ rememberedFeeds, feeds: deriveFeeds(rememberedFeeds, get().sessions) });
    } catch (e) {
      get().addLog(i18next.t('log.feedsLoadFailed', { error: String(e) }), 'error');
      return;
    }
    void get().restoreRememberedFeeds();
  },

  loadFeedCarrier: async () => {
    try {
      set({ feedCarrier: await api.getFeedCarrier() });
    } catch (e) {
      get().addLog(i18next.t('log.feedCarrierLoadFailed', { error: String(e) }), 'error');
    }
    // The carrier arriving is the moment every recorded-but-undeliverable feed
    // becomes deliverable; whichever of the three inputs landed last calls it.
    void get().restoreRememberedFeeds();
  },

  setFeedCarrier: async (render, capture) => {
    const previous = get().feedCarrier;
    set({ feedCarrier: { render, capture } });
    try {
      await api.setFeedCarrier(render, capture);
      get().addLog(i18next.t('log.feedCarrierSet'), 'success');
      // Same as the load path: a carrier moving re-opens every suspended rule.
      void get().restoreRememberedFeeds();
    } catch (e) {
      set({ feedCarrier: previous });
      get().addLog(i18next.t('log.feedCarrierSetFailed', { error: String(e) }), 'error');
    }
  },

  loadCaptureDevices: async () => {
    try {
      set({ captureDevices: await api.listCaptureDevices() });
    } catch (e) {
      get().addLog(i18next.t('log.captureDevicesFailed', { error: String(e) }), 'error');
    }
  },

  addFeed: async (sourcePid, targetPid) => {
    const { sessions, feeds } = get();
    if (sourcePid === targetPid) return;
    if ((feeds[sourcePid] ?? []).includes(targetPid)) return;
    const source = sessions.find((s) => s.pid === sourcePid);
    const target = sessions.find((s) => s.pid === targetPid);
    if (source === undefined || target === undefined) return;
    // Optimistic, like every other immediate change: the board shows the wire
    // now, the backend records the rule and pins whatever endpoints it can.
    set((s) => ({
      feeds: { ...s.feeds, [sourcePid]: [...(s.feeds[sourcePid] ?? []), targetPid] },
      rememberedFeeds: rememberFeedTargets(s.rememberedFeeds, source.exe_name, target.exe_name, true),
      feedUndo: { sourcePid, targetPid, added: true },
    }));
    try {
      const outcome = await api.setFeedTarget(
        sourcePid,
        source.exe_name,
        targetPid,
        target.exe_name,
      );
      if (outcome.delivered) {
        get().addLog(
          i18next.t('log.feedSet', { source: source.exe_name, target: target.exe_name }),
          'success',
        );
      } else if (outcome.reason === 'source_routed') {
        // Recorded, suspended: the board keeps the node and says why nothing
        // moves until the source's device route stops.
        get().addLog(
          i18next.t('log.feedSuspended', { source: source.exe_name, target: target.exe_name }),
          'info',
        );
      } else {
        get().addLog(
          i18next.t('log.feedNoCarrier', { source: source.exe_name, target: target.exe_name }),
          'error',
        );
      }
    } catch (e) {
      // The backend refused the rule: roll the whole optimistic write back, so
      // the UI never shows a wire the audio service does not know about.
      set((s) => {
        const nextFeeds = { ...s.feeds };
        const remaining = (nextFeeds[sourcePid] ?? []).filter((pid) => pid !== targetPid);
        if (remaining.length === 0) delete nextFeeds[sourcePid];
        else nextFeeds[sourcePid] = remaining;
        return {
          feeds: nextFeeds,
          rememberedFeeds: rememberFeedTargets(
            s.rememberedFeeds,
            source.exe_name,
            target.exe_name,
            false,
          ),
          feedUndo: null,
        };
      });
      get().addLog(i18next.t('log.feedSetFailed', { error: String(e) }), 'error');
    }
  },

  removeFeed: async (sourcePid, targetPid) => {
    const { sessions, feeds } = get();
    if (!(feeds[sourcePid] ?? []).includes(targetPid)) return;
    const source = sessions.find((s) => s.pid === sourcePid);
    const target = sessions.find((s) => s.pid === targetPid);
    const previousFeeds = { ...feeds };
    const previousMemory = get().rememberedFeeds;
    set((s) => {
      const nextFeeds = { ...s.feeds };
      const remaining = (nextFeeds[sourcePid] ?? []).filter((pid) => pid !== targetPid);
      if (remaining.length === 0) delete nextFeeds[sourcePid];
      else nextFeeds[sourcePid] = remaining;
      return {
        feeds: nextFeeds,
        rememberedFeeds:
          source !== undefined && target !== undefined
            ? rememberFeedTargets(s.rememberedFeeds, source.exe_name, target.exe_name, false)
            : s.rememberedFeeds,
        feedUndo: { sourcePid, targetPid, added: false },
      };
    });
    try {
      await api.removeFeedTarget(sourcePid, targetPid);
      if (source !== undefined && target !== undefined) {
        get().addLog(
          i18next.t('log.feedRemoved', { source: source.exe_name, target: target.exe_name }),
          'info',
        );
      }
    } catch (e) {
      // The backend kept the rule: put the wire and the memory back rather than
      // showing a board that disagrees with the audio service.
      set({
        feeds: previousFeeds,
        rememberedFeeds: previousMemory,
        feedUndo: null,
      });
      get().addLog(i18next.t('log.feedRemoveFailed', { error: String(e) }), 'error');
    }
  },

  restoreRememberedFeeds: async () => {
    const { rememberedFeeds, sessions, feedCarrier, feeds, routedPids } = get();
    if (rememberedFeeds.length === 0) return;
    if (feedCarrier.render === null || feedCarrier.capture === null) return;
    const pidByExe = lowestPidByExe(sessions);
    if (pidByExe.size === 0) return;
    const pairs: {
      sourcePid: number;
      sourceExe: string;
      targetPid: number;
      targetExe: string;
    }[] = [];
    for (const entry of rememberedFeeds) {
      const sourcePid = pidByExe.get(entry.sourceExe.toLowerCase());
      if (sourcePid === undefined) continue;
      // A source routed to a device has its one per-app render slot taken; the
      // backend would only record the rule as suspended, and the board already
      // shows that. Stopping the route resumes the feed on the backend side.
      if ((routedPids[sourcePid]?.length ?? 0) > 0) continue;
      for (const targetExe of entry.targetExe) {
        const targetPid = pidByExe.get(targetExe.toLowerCase());
        if (targetPid === undefined || targetPid === sourcePid) continue;
        if ((feeds[sourcePid] ?? []).includes(targetPid)) continue;
        const key = `${sourcePid}|${targetExe.toLowerCase()}`;
        if (feedRestoreDecided.has(key)) continue;
        pairs.push({ sourcePid, sourceExe: entry.sourceExe, targetPid, targetExe });
      }
    }
    if (pairs.length === 0) return;
    // Claimed before the first await, like the device-route restore: a refresh
    // landing mid-flight must not double-pin the same endpoints.
    for (const pair of pairs) {
      feedRestoreDecided.add(`${pair.sourcePid}|${pair.targetExe.toLowerCase()}`);
    }
    const results = await Promise.allSettled(
      pairs.map((pair) =>
        api.setFeedTarget(pair.sourcePid, pair.sourceExe, pair.targetPid, pair.targetExe),
      ),
    );
    const restored: Record<number, number[]> = {};
    results.forEach((result, index) => {
      const pair = pairs[index];
      if (pair === undefined) return;
      if (result.status === 'fulfilled' && result.value.delivered) {
        restored[pair.sourcePid] = [...(restored[pair.sourcePid] ?? []), pair.targetPid];
        get().addLog(
          i18next.t('log.feedRestored', { source: pair.sourceExe, target: pair.targetExe }),
          'info',
        );
      }
      // A suspension or a missing carrier stays silent in a restore pass: the
      // board shows both states, and a boot sweep has no business scolding the
      // user for a configuration it can see.
    });
    if (Object.keys(restored).length === 0) return;
    set((s) => {
      const nextFeeds = { ...s.feeds };
      for (const [sourcePidKey, targetPids] of Object.entries(restored)) {
        const sourcePid = Number(sourcePidKey);
        const existing = nextFeeds[sourcePid] ?? [];
        nextFeeds[sourcePid] = [...existing, ...targetPids.filter((t) => !existing.includes(t))];
      }
      return { feeds: nextFeeds };
    });
  },

  undoFeed: async () => {
    const offer = get().feedUndo;
    if (offer === null) return;
    // Consumed first, like the route undo: the inverse action below must not
    // open its own offer on top of the one being used.
    set({ feedUndo: null });
    if (offer.added) await get().removeFeed(offer.sourcePid, offer.targetPid);
    else await get().addFeed(offer.sourcePid, offer.targetPid);
    // Either inverse re-opens an offer of its own; this was the undo, so the
    // chain stops here.
    set({ feedUndo: null });
  },

  dismissFeedUndo: () => set({ feedUndo: null }),

  loadShellSettings: async () => {
    // Both come from the native side: the close-to-tray preference sits with the
    // other backend settings, and the startup entry's source of truth is the
    // registry — Task Manager can delete it, and the switch has to show that.
    try {
      const [closeToTray, autostart] = await Promise.all([
        api.getCloseToTray(),
        api.getAutostart(),
      ]);
      set({ closeToTray, autostart });
    } catch (e) {
      get().addLog(i18next.t('log.shellSettingsFailed', { error: String(e) }), 'error');
    }
  },

  loadStartupNotice: async () => {
    // Decided on the Rust side, before the window existed: either this is the
    // first launch of a fresh install, or an earlier version ran here and may
    // have left per-app endpoint assignments behind (see `install.rs`).
    try {
      set({ startupNotice: await api.getStartupNotice() });
    } catch (e) {
      get().addLog(i18next.t('log.startupNoticeFailed', { error: String(e) }), 'error');
    }
  },

  dismissStartupNotice: async () => {
    set({ startupNotice: null });
    try {
      await api.ackStartupNotice();
    } catch (e) {
      // The notice is gone for this session either way; the file simply did not
      // record it, so the next launch shows it once more.
      get().addLog(i18next.t('log.startupNoticeAckFailed', { error: String(e) }), 'error');
    }
  },

  toggleCloseToTray: async () => {
    const next = !get().closeToTray;
    set({ closeToTray: next });
    try {
      await api.setCloseToTray(next);
      get().addLog(i18next.t(next ? 'log.closeToTrayOn' : 'log.closeToTrayOff'), 'info');
    } catch (e) {
      set({ closeToTray: !next });
      get().addLog(i18next.t('log.closeToTrayFailed', { error: String(e) }), 'error');
    }
  },

  toggleAutostart: async () => {
    const next = !get().autostart;
    set({ autostart: next });
    try {
      await api.setAutostart(next);
      get().addLog(i18next.t(next ? 'log.autostartOn' : 'log.autostartOff'), 'info');
    } catch (e) {
      // Writing HKCU\...\Run can genuinely fail; the switch must snap back rather
      // than lie about an entry that is not there.
      set({ autostart: !next });
      get().addLog(i18next.t('log.autostartFailed', { error: String(e) }), 'error');
    }
  },

  // The seam the routing paths in here share, and the only place this store
  // reaches for `applyRoute`: one program, one backend call, and the generation
  // of the engine it started. What that route means to the rest of the state is
  // the caller's to write — it is the only side that knows whether it is routing
  // one program or a whole selection.
  routeOne: (pid, exeName, deviceIds, remember) =>
    api.applyRoute(pid, exeName, deviceIds, remember),

  applyRoute: async () => {
    // A flighting request already owns the selection: a second click while the
    // first is in flight would dispatch a duplicate route against the same
    // targets. Let the first one land, then start from fresh state.
    if (get().applying) return;
    set({ applying: true });
    const { selectedPids, selectedDeviceIds, autoRemember, sessions } = get();
    if (selectedPids.length === 0 || selectedDeviceIds.length === 0) {
      set({ applying: false });
      get().addLog(i18next.t('log.selectProcessAndDevice'), 'error');
      return;
    }
    const targets = selectedPids.flatMap((pid) => {
      const session = sessions.find((s) => s.pid === pid);
      return session ? [{ pid, exeName: session.exe_name }] : [];
    });
    if (targets.length === 0) {
      set({ applying: false });
      get().addLog(i18next.t('log.processGone'), 'error');
      return;
    }
    const skipped = selectedPids.length - targets.length;
    if (skipped > 0) {
      get().addLog(i18next.t('log.someProcessesGone', { n: skipped }), 'info');
    }

    // Apply in delay order so the earliest device is the one the OS plays
    // natively; the selection is reordered along with it, which is what the
    // badges on the stage show.
    const ordered = orderByDelay(selectedDeviceIds, get().deviceDelays);
    const deviceNames = ordered.map((id) => get().devices.find((d) => d.id === id)?.name ?? id);
    const primary = deviceNames[0];
    const extra = ordered.length - 1;
    // What this route is about to replace, read before anything moves: the offer
    // to undo it is only as honest as the state it was taken from.
    const replaced: ReplacedRoute[] = targets.map((target) => {
      const previous = get().routedPids[target.pid];
      return {
        pid: target.pid,
        exeName: target.exeName,
        previous: previous === undefined ? null : [...previous],
      };
    });
    try {
      // One invoke per process, all of them in flight together: the backend
      // routes each PID on its own, so awaiting them in a loop simply added
      // their latencies up — a ten-process selection cost ten times one.
      const results = await Promise.allSettled(
        targets.map((target) => get().routeOne(target.pid, target.exeName, ordered, autoRemember)),
      );
      const applied: { pid: number; exeName: string; generation: number }[] = [];
      const errors: string[] = [];
      results.forEach((result, index) => {
        const target = targets[index];
        if (target === undefined) return;
        if (result.status === 'fulfilled') {
          applied.push({ ...target, generation: result.value });
        } else {
          errors.push(String(result.reason));
        }
      });
      if (applied.length === 0) {
        get().addLog(
          i18next.t('log.routeFailed', { error: errors[0] ?? 'unknown error' }),
          'error',
        );
        return;
      }

      // What the offer to undo will cover: the programs this route was actually
      // accepted for, not every process that was selected.
      const accepted = new Set(applied.map((t) => t.pid));
      // Only the processes the backend actually accepted keep a badge, an engine
      // identity and a memory; a partial apply must not claim the rest. One
      // `set` for the whole batch, so the stage repaints once.
      set((s) => ({
        routedPids: {
          ...s.routedPids,
          ...Object.fromEntries(applied.map((t) => [t.pid, [...ordered]])),
        },
        selectedDeviceIds: ordered,
        // The targets are now what the user chose and what was applied, so a
        // later click on another device adds a copy instead of replacing them.
        deviceSelectionPrefilled: false,
        // Mirrored locally so a program that plays again in this same session is
        // restored from what was just written, not from the boot-time copy.
        rememberedRoutes: autoRemember
          ? rememberTargets(
              s.rememberedRoutes,
              applied.map((t) => t.exeName),
              ordered,
            )
          : s.rememberedRoutes,
        engineGenerations: {
          ...s.engineGenerations,
          ...Object.fromEntries(applied.map((t) => [t.pid, t.generation])),
        },
        // This route is now what there is to undo, and it covers exactly the
        // programs it was accepted for — a previous offer is dropped with it.
        // The device it sent audio to rides along so the offer can name it.
        undoSnapshot: {
          entries: replaced.filter((entry) => accepted.has(entry.pid)),
          remembered: autoRemember,
          deviceName: primary ?? '',
          deviceCount: ordered.length,
        },
      }));
      const count = applied.length;
      // Both counts say something: how many programs went, and how many devices
      // each of them got. A route to three devices is not "routed to Speakers"
      // just because only one program was selected — the two copies are the
      // part worth reading about.
      const key =
        count > 1
          ? autoRemember
            ? 'log.routedMultiProcessRemembered'
            : 'log.routedMultiProcess'
          : extra > 0
            ? autoRemember
              ? 'log.routedMultiRemembered'
              : 'log.routedMulti'
            : autoRemember
              ? 'log.routedRemembered'
              : 'log.routed';
      get().addLog(
        i18next.t(key, {
          n: count,
          process: applied[0]?.exeName ?? '',
          device: primary,
          m: extra,
        }),
        'success',
      );
      if (errors.length > 0) {
        get().addLog(
          i18next.t('log.routePartiallyFailed', { ok: count, n: targets.length, error: errors[0] }),
          'error',
        );
      }
      // The engines are up now, and this is the only pass that asks each of them
      // how far behind its device plays. The badges above say what was applied;
      // this is what makes the readings appear with the route instead of waiting
      // for the next route, or for Core Audio to move.
      await get().reconcileActiveDuplications();
    } catch (e) {
      get().addLog(i18next.t('log.routeFailed', { error: String(e) }), 'error');
    } finally {
      // Always release the flighting flag — a failed route must not leave the
      // hub latched disabled against a still-routable selection.
      set({ applying: false });
    }
  },

  undoLastRoute: async () => {
    const snapshot = get().undoSnapshot;
    if (snapshot === null) return;
    // Consumed before the work starts: a second activation — or a route landing
    // while this unwinds — must not undo the same thing twice. It is also what
    // keeps the stops below from dropping the offer they are running from.
    set({ undoSnapshot: null });
    let failure: string | null = null;
    let memoryDiffers = false;
    for (const entry of snapshot.entries) {
      const previous = entry.previous;
      try {
        if (previous === null || previous.length === 0) {
          // Back to the system default through the same stop a manual one uses:
          // that is the path that releases the program's fixed endpoint, and one
          // left behind would hold it on a device the user thinks they left.
          await get().stopRoute(entry.pid);
          // A stop leaves the memory alone on purpose — a stopped route stays
          // remembered — but the apply wrote this program's memory, and leaving
          // that write behind would apply the route the user just undid the next
          // time the program starts. Putting the old memory back is not possible
          // without a command to write one, so it is cleared instead: losing a
          // route that was not in effect is the smaller loss.
          if (snapshot.remembered) {
            await api.clearRoute(entry.exeName);
            memoryDiffers = true;
          }
          continue;
        }
        // Ordered by delay like every other path that starts an engine: the
        // earliest device has to become the one Windows plays, or a delay the
        // user set on the old primary is silently not applied at all.
        const ordered = orderByDelay(previous, get().deviceDelays);
        // `remember` mirrors what the apply did, because that is what puts the
        // memory back: with it false the old device list would never be written
        // and the memory would keep naming the route being undone.
        const generation = await get().routeOne(
          entry.pid,
          entry.exeName,
          ordered,
          snapshot.remembered,
        );
        if (snapshot.remembered) memoryDiffers = true;
        // Written here, one program at a time: an undo is a single user action
        // rather than a fan-out, and the generation is what a later
        // duplication-stopped event for this engine is measured against.
        set((s) => ({
          routedPids: { ...s.routedPids, [entry.pid]: [...ordered] },
          engineGenerations: { ...s.engineGenerations, [entry.pid]: generation },
        }));
      } catch (e) {
        // One line for the whole action, not one per program.
        failure ??= String(e);
      }
    }
    // Re-read rather than patch the mirror by hand: the backend is the truth for
    // what was written, and it is the state the settings list shows.
    if (memoryDiffers) await get().loadRememberedRoutes();
    // What this put back is duplicating now, so its readings are due for the
    // same reason a freshly applied route's are.
    await get().reconcileActiveDuplications();
    if (failure === null) {
      get().addLog(i18next.t('log.routeUndone', { n: snapshot.entries.length }), 'info');
    } else {
      get().addLog(i18next.t('log.routeUndoFailed', { error: failure }), 'error');
    }
  },

  dismissUndo: () => set({ undoSnapshot: null }),

  stopRoute: async (pid) => {
    const session = get().sessions.find((s) => s.pid === pid);
    // Snapshot before mutating: if the backend rejects the stop the UI must
    // keep showing the route as live instead of silently desyncing from it.
    const previous = get().routedPids[pid];
    if (previous === undefined) return;
    // The offer on screen describes the route this stop is taking apart, so it
    // is no longer the thing being offered: acting on it would undo the user's
    // last move instead of the one they meant to take back.
    set({ undoSnapshot: null });
    // The user just took this one off; a restore must not put it straight back.
    autoRestoreDecided.add(pid);
    const previousGeneration = get().engineGenerations[pid] ?? 0;
    const process = session?.exe_name ?? `PID ${pid}`;
    try {
      // Optimistic: reflect the stop immediately so the UI feels instant.
      set((s) => {
        const routedPids = { ...s.routedPids };
        delete routedPids[pid];
        const wasOnlySelection = s.selectedPids.length === 1 && s.selectedPids[0] === pid;
        return {
          routedPids,
          selectedPids: s.selectedPids.filter((p) => p !== pid),
          selectedDeviceIds: wasOnlySelection ? [] : s.selectedDeviceIds,
          engineGenerations: { ...s.engineGenerations, [pid]: 0 },
        };
      });
      const outcome = await api.stopRoute(pid);
      if (outcome.released) {
        get().addLog(i18next.t('log.routeStopped', { process }), 'info');
      } else {
        // The program plays on the current default again, but Windows still
        // holds a fixed output device for it, and that has to be said out loud:
        // switching devices by hand will not move the program until the
        // assignment is released, and only the settings page can do that.
        const device = outcome.pinned_device;
        get().addLog(
          device === null
            ? i18next.t('log.routeStoppedUnreleased', { process })
            : i18next.t('log.routeStoppedStillPinned', {
                process,
                device: get().devices.find((d) => d.id === device)?.name ?? device,
              }),
          'error',
        );
      }
    } catch (e) {
      // Backend didn't actually stop: roll the route and its event identity back.
      set((s) => ({
        routedPids: { ...s.routedPids, [pid]: previous },
        engineGenerations: { ...s.engineGenerations, [pid]: previousGeneration },
      }));
      get().addLog(i18next.t('log.stopRouteFailed', { error: String(e) }), 'error');
    }
  },

  stopAllRoutes: async () => {
    const pids = Object.keys(get().routedPids).map(Number);
    if (pids.length === 0) return;
    // As with a single stop: the offer describes routes the user is taking apart
    // by hand right now, so it is not an offer any more.
    set({ undoSnapshot: null });
    // Same rule as a single stop: none of these may be restored under the user.
    for (const pid of pids) autoRestoreDecided.add(pid);
    const names = new Map(get().sessions.map((s) => [s.pid, s.exe_name] as const));
    // Optimistic: assume every stop succeeds, then put back the ones that
    // didn't. Failed stops must keep their route live rather than desyncing
    // the UI from an engine that is still duplicating.
    const snapshot = { ...get().routedPids };
    const generationSnapshot = { ...get().engineGenerations };
    set({ routedPids: {}, engineGenerations: {} });
    const results = await Promise.allSettled(pids.map((pid) => api.stopRoute(pid)));
    const failed: number[] = [];
    const stillPinned: string[] = [];
    results.forEach((result, index) => {
      const pid = pids[index];
      if (pid === undefined) return;
      if (result.status === 'rejected') {
        failed.push(pid);
        get().addLog(i18next.t('log.stopRouteFailed', { error: String(result.reason) }), 'error');
      } else if (!result.value.released) {
        // Stopped, but the program keeps a fixed output device: one line for the
        // whole batch is enough, the single-stop case names the device.
        stillPinned.push(names.get(pid) ?? `PID ${pid}`);
      }
    });
    set((s) => {
      const routedPids: Record<number, string[]> = {};
      const engineGenerations: Record<number, number> = {};
      for (const pid of failed) {
        routedPids[pid] = snapshot[pid] ?? [];
        engineGenerations[pid] = generationSnapshot[pid] ?? 0;
      }
      const selectedPids = s.selectedPids.filter((p) => !pids.includes(p) || failed.includes(p));
      return {
        routedPids,
        selectedPids,
        selectedDeviceIds: selectedPids.length === 0 ? [] : s.selectedDeviceIds,
        engineGenerations,
      };
    });
    get().addLog(
      i18next.t('log.stoppedAll', { n: pids.length - failed.length }),
      failed.length > 0 ? 'error' : 'info',
    );
    if (stillPinned.length > 0) {
      get().addLog(
        i18next.t('log.stoppedAllStillPinned', {
          n: stillPinned.length,
          processes: stillPinned.join(', '),
        }),
        'error',
      );
    }
  },

  resetPinnedEndpoints: async () => {
    try {
      const outcome = await api.resetPinnedEndpoints();
      get().addLog(i18next.t('log.pinnedEndpointsReset', { n: outcome.released }), 'info');
      if (outcome.still_pinned.length > 0) {
        get().addLog(
          i18next.t('log.pinnedEndpointsRemaining', {
            processes: outcome.still_pinned.join(', '),
          }),
          'error',
        );
      }
      return outcome;
    } catch (e) {
      get().addLog(i18next.t('log.pinnedEndpointsResetFailed', { error: String(e) }), 'error');
      return null;
    }
  },

  releaseStaleRoutes: async () => {
    try {
      const released = await api.releaseStaleRoutes();
      if (released.length > 0) {
        get().addLog(
          i18next.t('log.staleAssignmentReleased', { processes: released.join(', ') }),
          'info',
        );
      }
    } catch {
      /* best effort: the sweep runs again after the next session refresh */
    }
  },

  loadDelaySettings: async () => {
    try {
      const [delays, delayRangeMs] = await Promise.all([
        api.getDeviceDelays(),
        api.getDelayRange(),
      ]);
      const deviceDelays: Record<string, number> = {};
      for (const [deviceId, delayMs] of delays) {
        deviceDelays[deviceId] = delayMs;
      }
      set({ deviceDelays, delayRangeMs });
    } catch (e) {
      get().addLog(i18next.t('log.delaySettingsFailed', { error: String(e) }), 'error');
    }
  },

  loadDeviceVolumes: async () => {
    try {
      const pairs = await api.getDeviceVolumes();
      const deviceVolumes: Record<string, number> = {};
      for (const [deviceId, percent] of pairs) {
        deviceVolumes[deviceId] = percent;
      }
      set({ deviceVolumes });
    } catch (e) {
      get().addLog(i18next.t('log.deviceVolumesFailed', { error: String(e) }), 'error');
    }
  },

  setDeviceVolume: async (deviceId, percent) => {
    const current = get().deviceVolumes[deviceId] ?? 100;
    if (current === percent) return;
    const device = get().devices.find((d) => d.id === deviceId);
    set((s) => {
      const deviceVolumes = { ...s.deviceVolumes };
      if (percent >= 100) {
        delete deviceVolumes[deviceId];
      } else {
        deviceVolumes[deviceId] = percent;
      }
      return { deviceVolumes };
    });
    try {
      await api.setDeviceVolume(deviceId, percent);
      get().addLog(
        i18next.t('log.deviceVolumeSet', { device: device?.name ?? deviceId, n: percent }),
        'info',
      );
    } catch (e) {
      // The backend rejected the value; undo the optimistic update so the UI
      // keeps matching what the engine actually applies and persists.
      set((s) => {
        const deviceVolumes = { ...s.deviceVolumes };
        if (current >= 100) {
          delete deviceVolumes[deviceId];
        } else {
          deviceVolumes[deviceId] = current;
        }
        return { deviceVolumes };
      });
      get().addLog(i18next.t('log.deviceVolumeFailed', { error: String(e) }), 'error');
    }
  },

  loadPrimaryVolumes: async () => {
    try {
      const pairs = await api.getPrimaryVolumes();
      const primaryVolumes: Record<string, number> = {};
      for (const [exeName, percent] of pairs) {
        primaryVolumes[exeName] = percent;
      }
      set({ primaryVolumes });
    } catch (e) {
      get().addLog(i18next.t('log.primaryVolumesFailed', { error: String(e) }), 'error');
    }
  },

  setPrimaryVolume: async (exeName, percent) => {
    const current = get().primaryVolumes[exeName] ?? 100;
    if (current === percent) return;
    set((s) => {
      const primaryVolumes = { ...s.primaryVolumes };
      // Only an exact 100 is dropped: it is the neutral point ("the program's
      // own loudness") rather than a boundary, and 5–99 are values of their
      // own the backend keeps.
      if (percent === 100) {
        delete primaryVolumes[exeName];
      } else {
        primaryVolumes[exeName] = percent;
      }
      return { primaryVolumes };
    });
    try {
      await api.setPrimaryVolume(exeName, percent);
      get().addLog(i18next.t('log.primaryVolumeSet', { process: exeName, n: percent }), 'info');
    } catch (e) {
      // The backend rejected the value; undo the optimistic update so the UI
      // keeps matching the session volume the engines actually apply.
      set((s) => {
        const primaryVolumes = { ...s.primaryVolumes };
        if (current === 100) {
          delete primaryVolumes[exeName];
        } else {
          primaryVolumes[exeName] = current;
        }
        return { primaryVolumes };
      });
      get().addLog(i18next.t('log.primaryVolumeFailed', { error: String(e) }), 'error');
    }
  },

  loadSourceVolumes: async () => {
    try {
      const pairs = await api.getSourceVolumes();
      const sourceVolumes: Record<string, number> = {};
      for (const [exeName, percent] of pairs) {
        sourceVolumes[exeName] = percent;
      }
      set({ sourceVolumes });
    } catch (e) {
      get().addLog(i18next.t('log.sourceVolumesFailed', { error: String(e) }), 'error');
    }
  },

  setSourceVolume: async (exeName, percent) => {
    const current = get().sourceVolumes[exeName] ?? 100;
    if (current === percent) return;
    set((s) => {
      const sourceVolumes = { ...s.sourceVolumes };
      // Only an exact 100 is dropped: it is this range's neutral point rather
      // than its top, so 101 and up are levels in their own right and have to
      // survive as entries. The backend stores by the same rule.
      if (percent === 100) {
        delete sourceVolumes[exeName];
      } else {
        sourceVolumes[exeName] = percent;
      }
      return { sourceVolumes };
    });
    try {
      await api.setSourceVolume(exeName, percent);
      get().addLog(i18next.t('log.sourceVolumeSet', { process: exeName, n: percent }), 'info');
    } catch (e) {
      // The backend rejected the value; undo the optimistic update so the UI
      // keeps matching what the engine actually applies and persists.
      set((s) => {
        const sourceVolumes = { ...s.sourceVolumes };
        if (current === 100) {
          delete sourceVolumes[exeName];
        } else {
          sourceVolumes[exeName] = current;
        }
        return { sourceVolumes };
      });
      get().addLog(i18next.t('log.sourceVolumeFailed', { error: String(e) }), 'error');
    }
  },

  alignSourceLevels: async () => {
    try {
      const { aligned, leftAlone, playing } = await api.alignSourceLevels();
      // One line for the whole action, and it says both halves: what it changed
      // and what it walked past. A program that was not making a sound is not a
      // failure, but it is the reason the numbers on screen moved unevenly —
      // and when nothing changed, the count alone would read as a no-op that
      // explains nothing. There are two ways for nothing to change and they need
      // different words: nothing was playing at all, or exactly one program was,
      // and one program cannot be aligned against itself. The likeliest first
      // move a user makes is clicking Align while listening to a single program.
      get().addLog(
        i18next.t(
          aligned.length === 0
            ? playing === 1
              ? 'log.sourceLevelsAlignedOne'
              : 'log.sourceLevelsAlignedNone'
            : leftAlone.length === 0
              ? 'log.sourceLevelsAligned'
              : 'log.sourceLevelsAlignedSome',
          { n: aligned.length, processes: leftAlone.join(', ') },
        ),
        'info',
      );
    } catch (e) {
      get().addLog(i18next.t('log.sourceLevelsAlignFailed', { error: String(e) }), 'error');
    }
    // Read the levels back rather than trusting the ones this side could have
    // predicted: the backend rounds each gain and bounds it by that program's
    // own measured peak, and a run that failed halfway has still written some.
    await get().loadSourceVolumes();
  },

  loadMissingIcons: () => {
    // Exes no longer on the list are not our business: a retry timer aimed at
    // a departed process would only fire into an empty pass, and its spent
    // budget would follow the process around if it ever came back.
    const live = new Set<string>();
    for (const session of get().sessions) live.add(session.exe_name);
    for (const exeName of [...iconRetryTimers.keys()]) {
      if (!live.has(exeName)) clearIconRetry(exeName);
    }
    for (const exeName of [...iconRetries.keys()]) {
      if (!live.has(exeName)) iconRetries.delete(exeName);
    }

    // One ask per executable per pass: the icon belongs to the file, and the
    // first session's pid is as good an address as any of its siblings'.
    const asked = new Set<string>();
    for (const session of get().sessions) {
      const exeName = session.exe_name;
      if (asked.has(exeName)) continue;
      asked.add(exeName);
      // A data URL is final. `null` and "not asked yet" both fall through:
      // a miss is retried — first on its own, then on the next refresh —
      // never held against the exe.
      if (typeof get().iconByExe[exeName] === 'string') {
        clearIconRetry(exeName);
        continue;
      }
      if (iconsInFlight.has(exeName)) continue;
      // A pending retry is moot: this pass is what it was waiting for.
      clearIconTimer(exeName);
      iconsInFlight.add(exeName);
      api
        .getProcessIcon(session.pid)
        .then((icon) => {
          const url = icon === null ? null : rgbaToDataUrl(icon);
          set((s) => ({ iconByExe: { ...s.iconByExe, [exeName]: url } }));
          if (typeof url === 'string') clearIconRetry(exeName);
          else scheduleIconRetry(exeName);
        })
        .catch(() => {
          // Same settlement as "the file has no icon": the letter tile stays
          // for now, the retry asks again on its own, and nothing anywhere
          // logs an icon.
          set((s) => ({ iconByExe: { ...s.iconByExe, [exeName]: null } }));
          scheduleIconRetry(exeName);
        })
        .finally(() => {
          iconsInFlight.delete(exeName);
        });
    }
  },

  setDeviceDelayValue: async (deviceId, delayMs) => {
    const current = get().deviceDelays[deviceId] ?? 0;
    const next = clampDelay(delayMs, get().delayRangeMs);
    if (current === next) return;
    const device = get().devices.find((d) => d.id === deviceId);
    set((s) => ({ deviceDelays: { ...s.deviceDelays, [deviceId]: next } }));
    try {
      await api.setDeviceDelay(deviceId, next);
      get().addLog(
        i18next.t('log.delaySet', { device: device?.name ?? deviceId, n: next }),
        'info',
      );
      // The reading is made of this number, so it has to be re-asked: it is
      // taken from the running engines, and nothing else would tell them the
      // value moved. Without this the figure would sit at what the device was
      // playing at before the change, which is the one thing it exists to show.
      await get().reconcileActiveDuplications();
    } catch (e) {
      // The backend rejected the value; undo the optimistic update so the UI
      // keeps matching what the engine actually applies and persists.
      set((s) => {
        const deviceDelays = { ...s.deviceDelays };
        if (current === 0) {
          delete deviceDelays[deviceId];
        } else {
          deviceDelays[deviceId] = current;
        }
        return { deviceDelays };
      });
      get().addLog(i18next.t('log.delaySetFailed', { error: String(e) }), 'error');
    }
  },

  setDelayRange: async (rangeMs) => {
    const { delayRangeMs: previousRange, deviceDelays: previousDelays } = get();
    if (previousRange === rangeMs) return;
    // Lowering the range pulls the affected values down with it, matching what
    // the backend does when it persists the new bound.
    set((s) => {
      const deviceDelays: Record<string, number> = {};
      for (const [deviceId, delayMs] of Object.entries(s.deviceDelays)) {
        const clamped = clampDelay(delayMs, rangeMs);
        if (clamped !== 0) deviceDelays[deviceId] = clamped;
      }
      return { delayRangeMs: rangeMs, deviceDelays };
    });
    try {
      await api.setDelayRange(rangeMs);
      get().addLog(i18next.t('log.delayRangeSet', { n: rangeSeconds(rangeMs) }), 'info');
    } catch (e) {
      set({ delayRangeMs: previousRange, deviceDelays: previousDelays });
      get().addLog(i18next.t('log.delayRangeSetFailed', { error: String(e) }), 'error');
    }
  },

  setDelayStep: (stepMs) => {
    const step = clampStep(stepMs);
    if (get().delayStepMs === step) return;
    set({ delayStepMs: step });
    try {
      localStorage.setItem(DELAY_STEP_STORAGE_KEY, String(step));
    } catch {
      /* storage may be unavailable; the preference just does not persist */
    }
  },

  handleDuplicationReady: () => {
    // The engines have just answered for the first time, so their devices now
    // have readings where they had none. Nothing else asks again — a reading is
    // not a route action — so this is the event that makes the number appear
    // with the route instead of waiting for an unrelated one.
    void get().reconcileActiveDuplications();
  },

  handleDuplicationStopped: (event) => {
    const { pid, generation, reason, error } = event;
    // `stopped` is the ack of an explicit stop or re-route, both of which
    // already updated routedPids synchronously — the event may arrive after a
    // newer route was applied, so it must not clear state here.
    if (reason === 'stopped') return;
    // Reject stale events before logging too: an old engine must not produce a
    // misleading failure line for a route that has already been replaced.
    if (generation !== (get().engineGenerations[pid] ?? 0)) return;
    set((s) => {
      const routedPids = { ...s.routedPids };
      delete routedPids[pid];
      const engineGenerations = { ...s.engineGenerations };
      delete engineGenerations[pid];
      const selectedPids = s.selectedPids.filter((p) => p !== pid);
      const wasSelected = s.selectedPids.includes(pid);
      return {
        routedPids,
        engineGenerations,
        selectedPids,
        selectedDeviceIds: wasSelected && selectedPids.length === 0 ? [] : s.selectedDeviceIds,
      };
    });
    if (reason === 'error') {
      get().addLog(i18next.t('log.duplicationFailed', { pid, error: error ?? '' }), 'error');
    } else {
      get().addLog(i18next.t('log.duplicationProcessExited', { pid }), 'info');
    }
  },

  handleSessionActivity: ({ pid, active }) => {
    set((s) => {
      const soundingPids = { ...s.soundingPids };
      if (active) soundingPids[pid] = true;
      else delete soundingPids[pid];
      return { soundingPids };
    });
  },

  handleMirrorFailed: (event) => {
    const { pid, generation, deviceId, error } = event;
    // The same staleness guard as the engine-level event: a mirror belonging to
    // a route that has already been replaced must not edit the current one.
    if (generation !== (get().engineGenerations[pid] ?? 0)) return;
    const routed = get().routedPids[pid];
    if (routed === undefined || !routed.includes(deviceId)) return;
    // The first id is the primary — the endpoint the OS plays natively — and the
    // backend reports a mirror, never the primary: an engine holds its primary
    // apart from the copies it duplicates to. So a device reported at that
    // position means this store and the engine disagree about the route, and
    // simply dropping it would promote the next device into the primary slot —
    // a copy the engine is still duplicating to, now drawn as the one Windows
    // plays directly. The honest answer is to end the route instead of
    // reassigning its roles.
    if (routed[0] === deviceId) {
      set((s) => {
        const routedPids = { ...s.routedPids };
        const engineGenerations = { ...s.engineGenerations };
        delete routedPids[pid];
        delete engineGenerations[pid];
        return { routedPids, engineGenerations };
      });
      get().addLog(i18next.t('log.duplicationFailed', { pid, error }), 'error');
      return;
    }
    // The device is not playing anything, so it must not keep the live badge and
    // pulse that say otherwise. The rest of the route is unaffected.
    set((s) => ({
      routedPids: { ...s.routedPids, [pid]: routed.filter((id) => id !== deviceId) },
    }));
    const device = get().devices.find((d) => d.id === deviceId);
    get().addLog(
      i18next.t('log.mirrorFailed', { device: device?.name ?? deviceId, error }),
      'error',
    );
  },

  reconcileActiveDuplications: async () => {
    // The webview can reload while the native process keeps duplication engines
    // alive, so ask the backend for their exact ordered device lists and restore
    // the badges with the data the UI needs.
    try {
      const active = await api.getActiveDuplications();
      if (active.length === 0) {
        // Nothing is being duplicated, so nothing is being measured: a reading
        // that outlived its route would sit under a device describing a stream
        // that does not exist.
        set({ deviceLatencyMs: {} });
        return;
      }
      set((s) => {
        const routedPids = { ...s.routedPids };
        const engineGenerations = { ...s.engineGenerations };
        // Rebuilt rather than merged, like the badges above: only the devices an
        // engine is driving right now keep a reading.
        const deviceLatencyMs: Record<string, number> = {};
        for (const route of active) {
          if (route.deviceIds.length === 0) continue;
          routedPids[route.pid] = [...route.deviceIds];
          engineGenerations[route.pid] = route.generation;
          // Index 0 is the primary, which Windows plays natively and which
          // reports `null` because there is no stream of ours to ask. Every
          // entry past it is a mirror, and its reading is what the stage shows.
          for (let index = 1; index < route.deviceIds.length; index += 1) {
            const deviceId = route.deviceIds[index];
            const latencyMs = route.latencyMs[index];
            if (deviceId === undefined || latencyMs === undefined || latencyMs === null) continue;
            deviceLatencyMs[deviceId] = latencyMs;
          }
        }
        return { routedPids, engineGenerations, deviceLatencyMs };
      });
    } catch {
      /* enumerating active engines is best-effort; the user can re-route */
    }
  },

  addLog: (message, level = 'info') => {
    const ts = new Date().toLocaleTimeString(currentLanguage(), { hour12: false });
    set((s) => ({
      logs: [...s.logs, { id: ++logId, timestamp: ts, message, level }].slice(-200),
    }));
  },
}));
