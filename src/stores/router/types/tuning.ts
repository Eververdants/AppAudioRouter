/** The three volume axes and the two delay knobs — the tuning surface.
 *
 * The axes are separate on purpose (AGENTS.md red line): a device *share* only
 * ever attenuates a copy, a *primary volume* is the program's own session volume
 * (5–100) and reaches only its primary device, and a *source level* (0–400) is
 * what the engines apply to the program's audio on its way out. None of them is
 * a synonym for another, and no action here writes a session volume for a
 * program that is not routed. */
export interface TuningState {
  /**
   * What each device is really playing at, in milliseconds, keyed by device id:
   * the pipeline the engine holds for that device plus the endpoint's own
   * reported stream latency. Only mirrors appear — Windows plays the primary
   * itself, so there is no stream of ours there to measure. Rebuilt from the
   * running engines on every reconciliation, so a device that stops being
   * mirrored loses its reading instead of keeping a stale one.
   */
  deviceLatencyMs: Record<string, number>;
  /** Per-device delay compensation in milliseconds (signed). */
  deviceDelays: Record<string, number>;
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
   * The level this app applies to each program's audio on its way to the routed
   * devices, in percent, keyed by executable name — the same ownership rule the
   * routing assignments use, since one program can hold several sessions and the
   * level belongs to the program. 100 is the audio as the program produced it
   * and the middle of the range: below attenuates, above amplifies. A missing
   * entry is that neutral 100, which is also what the backend stores as "no
   * level".
   */
  sourceVolumes: Record<string, number>;
}

/** Every read and write of that surface. */
export interface TuningActions {
  loadDelaySettings: () => Promise<void>;
  loadDeviceVolumes: () => Promise<void>;
  setDeviceVolume: (deviceId: string, percent: number) => Promise<void>;
  /** Read the stored per-program primary volumes. */
  loadPrimaryVolumes: () => Promise<void>;
  /** Set one program's primary volume (percent, 5–100, 100 = untouched). */
  setPrimaryVolume: (exeName: string, percent: number) => Promise<void>;
  /** Read the stored per-program levels the engines apply. */
  loadSourceVolumes: () => Promise<void>;
  /** Set one program's own level (percent, 0–400, 100 = unchanged). */
  setSourceVolume: (exeName: string, percent: number) => Promise<void>;
  /** Bring every routed program that is playing up to the loudest one's level,
   * in one action, and re-read the values that wrote. */
  alignSourceLevels: () => Promise<void>;
  setDeviceDelayValue: (deviceId: string, delayMs: number) => Promise<boolean>;
  setDelayStep: (stepMs: number) => void;
}
