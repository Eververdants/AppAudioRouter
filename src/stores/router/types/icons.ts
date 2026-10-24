/** Each executable's icon, asked for behind the list and never in front of it. */
export interface IconsState {
  /**
   * Each executable's icon as a data URL, keyed by executable name — the icon
   * belongs to the file, and one browser with a dozen processes has one icon.
   * Display state only: filled in after a refresh by asks that never block the
   * list, `null` meaning "asked, and there is none". Absent means "not asked
   * yet", which is the letter tile's cue.
   */
  iconByExe: Record<string, string | null>;
}

export interface IconsActions {
  /** Ask the backend for the icons the current process list is missing, one
   * command per executable, without waiting for them: the rows render their
   * letter tiles immediately and the icon lands whenever the shell is done.
   * A settled miss does not stick — it re-arms its own bounded timer (three
   * tries, doubling), because the likeliest failure (the process died
   * mid-ask) is one a later ask gets past and a quiet system never raises a
   * refresh to lean on; a success is final and never asked for again. */
  loadMissingIcons: () => void;
}
