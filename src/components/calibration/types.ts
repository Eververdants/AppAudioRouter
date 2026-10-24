/** The wizard's three screens, in order. */
export type Step = 'select' | 'measure' | 'result';

/** Payload of the backend's `calibration-tone` events. */
export interface ToneMarker {
  index: number;
  phase: 'start' | 'end';
}

/** Why the run stopped short of a result, when it did. */
export interface MeasureFailure {
  /** The backend's complaint, when the run itself failed. */
  message: string | null;
  /** Devices that played through with no usable tap; they get a re-run. */
  noPresses: string[];
}

/**
 * The proposal the results screen shows, and the write-out of one choice of
 * baseline: what each device is told to hold itself back by, and which devices
 * will still be late because the engine's pipeline already outruns the
 * difference measured against the baseline.
 */
export interface ComputedDelays {
  values: Record<string, number>;
  lagging: { id: string; diff: number; late: number }[];
}
