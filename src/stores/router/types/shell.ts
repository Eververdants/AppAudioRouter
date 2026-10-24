import type { StartupNotice } from '@/lib/types';

/** The window-and-launch preferences, all of them read from the native side. */
export interface ShellState {
  /** Whether the close button hides the window to the tray instead of quitting. */
  closeToTray: boolean;
  /** Whether Windows starts this app at sign-in. */
  autostart: boolean;
  /** What the window says about this install: a welcome on a first run, or a
   * word about the assignments an earlier version may have left behind. Null
   * once acknowledged. */
  startupNotice: StartupNotice | null;
  /** Whether the install's own notice has been read yet. The work area waits
   *  for it: showing the board first and swapping to the tour a beat later is
   *  a first impression of two half-screens. */
  startupNoticeLoaded: boolean;
}

export interface ShellActions {
  /** Read the close-to-tray preference and the startup registry entry. */
  loadShellSettings: () => Promise<void>;
  /** Read what this install should be told about itself (first run / update). */
  loadStartupNotice: () => Promise<void>;
  /** Take the notice down and record that this version has run. */
  dismissStartupNotice: () => Promise<void>;
  /** Put the tour back on the screen. Acking it writes the version that is
   *  already on file, so replaying changes nothing about this machine — it only
   *  answers the one question the tour used to be able to answer: what was that
   *  second screen saying? */
  replayWizard: () => void;
  toggleCloseToTray: () => Promise<void>;
  toggleAutostart: () => Promise<void>;
}
