import { currentLanguage } from '@/i18n';
import { collectErrorMessage, isInErrorBatch, nextErrorId, nextLogId } from '../gates';
import type { GetRouterState, JournalActions, SetRouterState } from '../types';

/** The activity record, the notice, and where the window is showing.
 *
 *  Two channels, not one: `addLog` is the record, `raiseError` is the record
 *  *plus* a card where the user is looking — and only for what someone just
 *  asked for and did not get. A background read that failed reaches the log
 *  alone, or every launch would open holding a stack of complaints nobody
 *  caused. Inside a batch (`beginErrorBatch` in `../gates`) the card is
 *  collected instead of replaced, so one action says everything it failed at in
 *  one card. */
export function createJournalSlice(set: SetRouterState, get: GetRouterState): JournalActions {
  return {
    addLog: (message, level = 'info') => {
      const ts = new Date().toLocaleTimeString(currentLanguage(), { hour12: false });
      set((s) => ({
        logs: [...s.logs, { id: nextLogId(), timestamp: ts, message, level }].slice(-200),
        // An error line written while the record is closed is one nobody has
        // read: the activity tab wears the count until it is opened, because a
        // failure nobody saw is a failure nobody can act on.
        unreadErrors:
          level === 'error' && s.tab !== 'activity' ? s.unreadErrors + 1 : s.unreadErrors,
      }));
    },

    raiseError: (message, options = {}) => {
      // Inside a batched action, collect rather than replace: the card goes up
      // once when the action ends (see `beginErrorBatch`). The log line is never
      // deferred — every failure is on the record the moment it happens.
      if (isInErrorBatch()) {
        collectErrorMessage(message);
        get().addLog(message, 'error');
        return;
      }
      // Keyed on a counter, not on the text: the same refusal happening twice is
      // two notices, and the second one's countdown starts on its own arrival.
      set({
        errorNotice: {
          id: nextErrorId(),
          message,
          ...(options.detail === undefined ? {} : { detail: options.detail }),
          ...(options.sticky === true ? { sticky: true } : {}),
        },
      });
      get().addLog(message, 'error');
    },

    dismissError: () => set({ errorNotice: null }),

    setView: (view) => set({ view }),

    setTab: (tab) => set(tab === 'activity' ? { tab, unreadErrors: 0 } : { tab }),
  };
}
