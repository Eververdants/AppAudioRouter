/**
 * The shapes the fake runtime is made of.
 *
 * They live in their own module because the runtime is no longer one file: the
 * page-side core, the scripted graph and one command domain per kind of ask each
 * declare their half of the contract here. Only types may be shared that way —
 * every page-side function is serialized by Playwright on its own, so it can
 * close over nothing but what it declares itself and what it reads off `window`.
 */

export interface BridgeDevice {
  id: string;
  name: string;
}

export interface BridgeSession {
  pid: number;
  exe_name: string;
  /** How the process names itself to a person — its window title or version
   *  description. Absent reads as "no display name", the way a backend that
   *  found no window and no description would report it. */
  display_name?: string;
  /** Whether the session was rendering audio when enumerated; absent reads as
   *  "not sounding". */
  playing?: boolean;
}

export interface BridgeState {
  devices: BridgeDevice[];
  sessions: BridgeSession[];
  defaultDeviceId: string;
  remembered: [string, string[]][];
  delays: [string, number][];
  volumes: [string, number][];
  /** `(exe_name, percent)` — the per-program levels the store reads at boot. */
  sourceVolumes: [string, number][];
  /** `(exe_name, percent)` — the per-program primary (session) volumes. */
  primaryVolumes: [string, number][];
  /** Recording endpoints, for the settings page's carrier picker. */
  captureDevices: BridgeDevice[];
  /** Commands that refuse from the very first call, so a boot-time failure is
   *  reachable without a round-trip through `setFailing` after the app loaded. */
  failing?: string[];
  /** The loopback pair feeds are carried through; null halves mean "none set". */
  feedCarrier: { render: string | null; capture: string | null };
  /** `(source_exe, target_exe)` — the remembered feed rules. */
  feeds: [string, string][];
  /** Running apps with a visible window but no audio session — the feed
   *  picker's second tier, answered by `list_window_apps`. */
  windowApps: BridgeSession[];
}

/** Commands the fake backend should reject, by name. */
export type FailingCommands = string[];

/** One admitted run of the delay wizard's tone player, as
 *  `commands::calibration::calibration_start` admits it: the parameters after
 *  `audio::calibration`'s own clamps, and how the run ended. */
export interface BridgeCalibrationRun {
  /** The endpoint the burst was written to — the command's own argument. */
  device: string;
  /** The `run` token it was admitted under; `NO_RUN_TOKEN` when the caller
   *  named none. */
  token: number;
  reps: number;
  leadMs: number;
  tailMs: number;
  /** Page-clock instant the run was admitted. */
  startedAt: number;
  /** Null while it is still playing. */
  endedAt: number | null;
  /** Ended because `calibration_cancel` was asked to. */
  cancelled: boolean;
}

/** One start the tone player refused, with the words it answered by — the log
 *  line `commands::calibration::calibration_start` writes for a run the user had
 *  already called off, which is the only place a spec can see the crossing. */
export interface BridgeCalibrationRefusal {
  token: number;
  message: string;
  at: number;
}

/** One `calibration-tone` marker the player emitted, with the run it belongs
 *  to. The event's own payload stays `{ index, phase }`: only one run is ever
 *  alive, so the real backend never names a device in it. */
export interface BridgeToneMarker {
  run: number;
  device: string;
  index: number;
  phase: 'start' | 'end';
  at: number;
}

/** The tone player's books, as one piece of the fake's state: `CalibrationState`'s
 *  busy flag and its two staleness marks, the runs it admitted, and every marker
 *  it played. */
export interface BridgeCalibrationBooks {
  runs: BridgeCalibrationRun[];
  tones: BridgeToneMarker[];
  refusals: BridgeCalibrationRefusal[];
  busy: boolean;
  active: { cancelRequested: boolean } | null;
  /** `CalibrationState::cancelled_run`: the run the last named cancel aimed at,
   *  which is the only start that mark may refuse. */
  cancelledRun: number;
  /** `CalibrationState::stale_generation`: non-zero while an *unnamed* cancel
   *  that found no burst playing waits for the start it can only have been
   *  answering. */
  staleGeneration: number;
  /** `CalibrationState::generation`: how many cancels the player has taken. */
  cancelGeneration: number;
  /** Starts the worker has not polled yet — see `holdCalibrationStarts`. */
  held: boolean;
  queue: (() => void)[];
}

/** One command the frontend sent, in order. */
export interface BridgeCall {
  cmd: string;
  args: Record<string, unknown>;
}

/** Everything the fake keeps: the graph a spec installed, plus what the commands
 *  wrote into it. The page-side core builds this object once and every other
 *  page-side module reaches the same instance through `window.__AAR_BRIDGE__`. */
export interface BridgeRuntimeState extends BridgeState {
  /** Live routes by pid, in the plan's device order. */
  routes: Record<string, string[]>;
  /** Per-route engine generation, as `apply_route` handed it out. */
  routeGenerations: Record<string, number>;
  /** Which engine generation has reported `duplication-ready`, so its mirrors
   *  have a latency reading to hand back. */
  readyGenerations: Record<string, number>;
  /** The delay wizard's tone player, books and all. */
  calibration: BridgeCalibrationBooks;
  /** Every command the frontend sent, in order. */
  calls: BridgeCall[];
  /** The next engine generation: `apply_route` hands these out in order. */
  generation: number;
  /** The mutable copy of `BridgeState.failing`, which a spec can move. */
  failing: string[];
}

/** What one command answers, given the payload the frontend sent. */
export type CommandHandler = (payload: Record<string, unknown>) => unknown;

/** The mirrored Rust numbers and words, as the page-side modules name them. The
 *  bundle is declared here because a value cannot be imported into a Playwright
 *  init script; `constants.ts` fills it in, first, before anything reads it. */
export interface BridgeConstants {
  /** `audio::calibration`'s tone player: burst length, repetitions and the clamp
   *  bounds for a caller-supplied lead and tail. */
  TONE_BURST_MS: number;
  TONE_REPS_DEFAULT: number;
  TONE_REPS_MAX: number;
  LEAD_MS_DEFAULT: number;
  TAIL_MS_DEFAULT: number;
  LEAD_MS_MIN: number;
  LEAD_MS_MAX: number;
  TAIL_MS_MIN: number;
  TAIL_MS_MAX: number;
  /** The silence drawn before every burst, and the ceiling on a cancelled run's
   *  wake-ups. */
  GAP_MIN_MS: number;
  GAP_MAX_MS: number;
  CANCEL_BACKSTOP_MS: number;
  /** `audio::calibration::NO_RUN_TOKEN`. */
  NO_RUN_TOKEN: number;
  /** `Refusal::Cancelled::message()` and `Refusal::Busy::message()`. */
  SUPERSEDED_MESSAGE: string;
  BUSY_MESSAGE: string;
  /** `audio::routing::validate_device_id`'s bound. */
  MAX_DEVICE_ID_LEN: number;
  /** `config::DELAY_MAX_MS`. */
  DELAY_MAX_MS: number;
}

/** The shared page-side context: the one thing the command domain modules touch,
 *  handed to them by the core through `window` because nothing else crosses the
 *  serialization boundary. */
export interface BridgeBoot {
  state: BridgeRuntimeState;
  /** The command handlers, keyed by the name the frontend invokes. The core's
   *  dispatcher looks a command up here and answers `null` for one nobody
   *  registered — the same `default` arm the switch had. */
  handlers: Map<string, CommandHandler>;
  /** Hand an event to everything subscribed to it, the way the notification
   *  thread does. */
  deliver: (event: string, payload: unknown) => void;
}

/** What the page exposes for a test to read and drive. */
export interface BridgeHandle {
  /** Every command the frontend sent, in order. */
  calls: () => { cmd: string; args: Record<string, unknown> }[];
  /** The subset for one command, e.g. `callsFor('apply_route')`. */
  callsFor: (cmd: string) => { cmd: string; args: Record<string, unknown> }[];
  /** Push a backend event the way the Rust notification thread would. */
  emit: (event: string, payload: unknown) => void;
  setSessions: (sessions: BridgeSession[]) => void;
  setDevices: (devices: BridgeDevice[]) => void;
  setFailing: (commands: FailingCommands) => void;
  /** Say whether the window holds the OS focus, the way the shell would, and
   *  hand the app the matching event. */
  setFocused: (focused: boolean) => void;
  /** Forget the recorded calls, so a later assertion sees only new ones. */
  resetCalls: () => void;
  /** Every calibration run the tone player admitted, in order. */
  calibrationRuns: () => BridgeCalibrationRun[];
  /** Every `calibration-tone` marker it played, with its page-clock instant. */
  calibrationTones: () => BridgeToneMarker[];
  /** Every `calibration_start` the tone player refused, in order. */
  calibrationRefusals: () => BridgeCalibrationRefusal[];
  /** Hold the tone player's admission queue open, or drain it.
   *
   *  `calibration_start` is an async command: its body — the `begin` that admits
   *  the run — is polled on a runtime worker, while the sync `calibration_cancel`
   *  is answered at once. That hand-off is the whole reason a run token exists: a
   *  cancel can be handled before the start it was pressed against has been
   *  admitted. One thread cannot cross the two on its own, so a held start sits
   *  between the wizard's `invoke` and the player's `begin` until the spec opens
   *  the gate — the state the real backend is in while the command is in flight. */
  holdCalibrationStarts: (hold: boolean) => void;
}

/** The IPC surface `@tauri-apps/api/core` looks for on the global. The package
 *  ships no type for it — the unit tests reach it through `unknown` — so the
 *  fake declares the members it fills in, and its own assignment is checked. */
interface TauriInternals {
  metadata: {
    currentWindow: { label: string };
    currentWebview: { windowLabel: string; label: string };
  };
  invoke: (cmd: string, args: Record<string, unknown> | undefined) => unknown;
  transformCallback: (callback: (data: unknown) => void) => number;
  unregisterCallback: (id: number) => void;
  runCallback: (id: number, data: unknown) => void;
  callbacks: Map<number, (data: unknown) => void>;
  convertFileSrc: (path: string) => string;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__: TauriInternals;
    __AAR__?: BridgeHandle & { state: BridgeState & Record<string, unknown> };
    /** The mirrored Rust numbers and words, installed by the constants script,
     *  which every page-side script is added after. */
    __AAR_CONSTANTS__: BridgeConstants;
    /** The shared page-side context, installed by the core's init script before
     *  any command domain reads it — every init script of one page runs in the
     *  order it was added, so this is always there by the time a domain asks. */
    __AAR_BRIDGE__: BridgeBoot;
    /** The shell's answer to `document.hasFocus()`, pinned so a spec does not
     *  depend on which parallel worker happened to hold focus. `setFocused`
     *  moves it for the specs that are about the gate itself. */
    __AAR_WINDOW_FOCUSED__?: boolean;
  }
}
