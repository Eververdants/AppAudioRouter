import i18next from 'i18next';
import * as api from '@/lib/invoke';
import type { GetRouterState, SetRouterState, ShellActions } from '../types';

/** The window-and-launch preferences. Both come from the native side — the
 *  close-to-tray preference sits with the other backend settings and the
 *  startup entry's truth is the registry, because Task Manager can delete it
 *  and the switch has to show that. */
export function createShellSlice(set: SetRouterState, get: GetRouterState): ShellActions {
  return {
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
        set({ startupNotice: await api.getStartupNotice(), startupNoticeLoaded: true });
      } catch (e) {
        // A read that failed still has to let the work area through: a blank
        // window is worse than a tour nobody was owed.
        set({ startupNoticeLoaded: true });
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

    replayWizard: () => {
      // The first-run shape: four screens of guide, and none of the questions
      // that belong to a machine walking in from an older version — those were
      // answered, or this screen would not be reachable at all.
      set({
        startupNotice: { kind: 'first-run', previous_version: null, leftover_endpoints: false },
      });
    },

    toggleCloseToTray: async () => {
      const next = !get().closeToTray;
      set({ closeToTray: next });
      try {
        await api.setCloseToTray(next);
        get().addLog(i18next.t(next ? 'log.closeToTrayOn' : 'log.closeToTrayOff'), 'info');
      } catch (e) {
        set({ closeToTray: !next });
        get().raiseError(i18next.t('log.closeToTrayFailed', { error: String(e) }), {
          detail: String(e),
        });
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
        get().raiseError(i18next.t('log.autostartFailed', { error: String(e) }), {
          detail: String(e),
        });
      }
    },
  };
}
