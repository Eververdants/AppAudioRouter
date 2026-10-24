import type { AudioChangedEvent, AudioDevice, AudioSession } from '@/lib/types';

/** What the two Core Audio enumerations hold right now, and why a read that
 *  failed is never shown as a list that is empty. */
export interface AudioState {
  devices: AudioDevice[];
  sessions: AudioSession[];
  /**
   * Whether the first session enumeration has returned, with a list or with an
   * error. An empty `sessions` before that is not a fact about the machine —
   * the enumeration is deferred past the first paint on purpose, so the rail
   * would otherwise open by claiming no app is playing sound.
   */
  sessionsLoaded: boolean;
  /** Whether an enumeration is in flight right now. The rail's Refresh button
   *  says so: a slow Core Audio answer used to look like a press that missed. */
  sessionsRefreshing: boolean;
  /**
   * Why the last enumeration of each list failed, in the backend's own words.
   * An empty list is a claim about the machine; a failed read is a claim about
   * this moment, and the two must never render as the same sentence. Cleared by
   * the next read that answers.
   */
  sessionsError: string | null;
  devicesError: string | null;
  /**
   * Which processes are rendering audio right now, keyed by PID.
   *
   * Seeded from the session list's `playing` flag on every refresh — the list
   * is the authority, so a process that left it stops sounding even if no
   * transition was observed — and kept current between refreshes by
   * `session-activity` events, which arrive the moment a session flips state
   * rather than when the next re-enumeration happens to run. A transition for
   * a process the list has not reported is not recorded: it has no executable
   * for `soundingExes` to be folded under, so keeping it would let one table
   * say "playing" while every per-program reader said "quiet". This is display
   * state only: nothing in the routing logic reads it.
   */
  soundingPids: Record<number, boolean>;
  /**
   * Which programs are rendering audio right now, keyed by lower-cased
   * executable name — `soundingPids` folded per program, so a list that draws
   * one row per program asks one key instead of walking the session list on
   * every store write. Derived, not a second ledger: both tables come out of
   * the same pass at the two places sound is recorded.
   */
  soundingExes: Record<string, true>;
  /**
   * System default render device. It is the endpoint a process plays through
   * until it gets an explicit route, so selecting a process falls back to it.
   */
  defaultDeviceId: string | null;
  /** Recording endpoints, for the carrier picker in settings. */
  captureDevices: AudioDevice[];
  /**
   * Every running app a person could name — processes owning a visible window,
   * one entry per executable — as feed-target candidates beyond the audio
   * session list. A feed's receiving end is often an app that has never opened
   * a render session (an idle recorder, a game in its menu), and the capture
   * pin it gets does not need one; the window is what makes an app nameable
   * and aimable. Read once at boot and again whenever the add-destination
   * picker opens — event-driven, never a poll.
   */
  windowApps: AudioSession[];
}

/** The reads that fill them, and the one notification fold that drives them. */
export interface AudioActions {
  /** Pull the device list from the audio engine. `viaNotification` marks a refresh
   * the backend's change callbacks provoked: it only reaches the log when the list
   * really differs from what the UI already shows. */
  refreshDevices: (viaNotification?: boolean) => Promise<void>;
  /** Pull the process list, with the same logging rule as [`refreshDevices`]. */
  refreshSessions: (viaNotification?: boolean) => Promise<void>;
  /** Fold one Core Audio change notification into the UI: refresh whatever moved
   * and quietly, since the user did not ask for this. */
  syncFromNotification: (changed: AudioChangedEvent) => Promise<void>;
  loadDefaultDevice: () => Promise<void>;
  /** Read the recording endpoints for the carrier picker. */
  loadCaptureDevices: () => Promise<void>;
  /** Read the running apps the feed picker can offer beyond the session list.
   *  Also re-derives the live feed map, whose targets may resolve through this
   *  pool alone, and asks for the restore like every other arriving input. */
  loadWindowApps: () => Promise<void>;
}
