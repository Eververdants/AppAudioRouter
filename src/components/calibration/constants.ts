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
export const TAP_EARLY_MS = 150;
export const TAP_LATE_MS = 900;

/** Valid presses a device needs before the wizard stops sampling it. */
export const MIN_VALID = 3;

/** Rounds every selected device plays before the extension rounds begin. */
export const MIN_ROUNDS = 3;

/** Hard cap on rounds per run, extensions included. */
export const MAX_ROUNDS = 6;

/** Lead silence before a round-robin burst, drawn per call from this span.
 * The backend randomizes the gap within a run; drawing the lead per call
 * keeps the pace unpredictable across the whole session. */
export const LEAD_MIN_MS = 300;
export const LEAD_SPREAD_MS = 600;

/** Tail between round-robin calls. The pump paces its writes at the padding
 * target, so a burst is already audible when a schedule ends — a long tail
 * would only be dead time between calls. */
export const CALL_TAIL_MS = 300;

/** What `Tab` may land on inside the dialog, in DOM order.
 *  `aria-modal` hides the page behind this dialog from assistive tech, but it
 *  does nothing to the tab order: without a trap the walk simply continues into
 *  the settings page and the stage under it, and a timed measurement spent
 *  hunting for a control the dialog is covering is a burst not heard. */
export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
