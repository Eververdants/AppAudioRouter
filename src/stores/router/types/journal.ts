import type { ErrorNotice, LogEntry, WorkTab, WorkView } from '@/lib/types';

/** The activity record, the one notice the user has to see without opening it,
 *  and which surface the window is showing. */
export interface JournalState {
  logs: LogEntry[];
  /**
   * A failure the user has to see without opening the activity tab, while the
   * notice stands. One at a time: a second failure replaces the first, the way
   * a new route replaces the undo offer that described the last one.
   */
  errorNotice: ErrorNotice | null;
  /** Error lines written since the activity tab was last open. The tab's own
   * dot: a failure nobody saw is a failure nobody can act on. */
  unreadErrors: number;
  /**
   * Which surface the window is showing, and which tab the work area is on.
   * They live here rather than in a component because more than one place has
   * to be able to move the user: the tray menu opens settings, the error card
   * offers the activity record, the briefing page walks back to the board.
   */
  view: WorkView;
  tab: WorkTab;
}

/** The two channels, which are not interchangeable (AGENTS.md red line):
 *  `raiseError` is only for what someone just asked for and did not get;
 *  a background read that failed reaches `addLog` alone. */
export interface JournalActions {
  addLog: (message: string, level?: LogEntry['level']) => void;
  /**
   * Report a failure where the user is looking, and in the log. Only for the
   * things someone just asked for that did not happen — a background read that
   * failed reaches the log alone, or every launch would open holding a stack of
   * complaints nobody caused.
   *
   * `options.detail` is the backend's own words: they travel with the card,
   * small and second, because they are evidence for a report rather than the
   * sentence a person reads. `options.sticky` holds the card up: a failure the
   * user has to act on (an engine that would not start, a mirror that went
   * quiet) must not disappear eight seconds later and leave them with silence.
   */
  raiseError: (message: string, options?: { detail?: string; sticky?: boolean }) => void;
  dismissError: () => void;
  /** Which surface the window shows, and which tab the work area is on. */
  setView: (view: WorkView) => void;
  setTab: (tab: WorkTab) => void;
}
