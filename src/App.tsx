import { useCallback, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { BriefingPage } from '@/components/BriefingPage';
import { NodeStage } from '@/components/NodeStage';
import { LogPanel } from '@/components/LogPanel';
import { ProgramRail } from '@/components/ProgramRail';
import { RoutedCapsule } from '@/components/RoutedCapsule';
import { SettingsPage } from '@/components/SettingsPage';
import { StartupWizard } from '@/components/StartupWizard';
import { TitleBar } from '@/components/TitleBar';
import { Toast } from '@/components/Toast';
import { tabButtonId, tabPanelId, UnderlineTabs } from '@/components/ui/UnderlineTabs';
import { useBackendEvent } from '@/hooks/useBackendEvent';
import { useRouterStore } from '@/stores/routerStore';
import type {
  AudioChangedEvent,
  DuplicationReadyEvent,
  DuplicationStoppedEvent,
  FeedTapFailedEvent,
  MirrorFailedEvent,
  SessionActivityEvent,
  TrayMenuEvent,
  WorkTab,
} from '@/lib/types';
import { FADE, MAIN_THREAD_TRANSFORM, SPRING_GLIDE } from '@/lib/motion';
import { isSilentLaunch, setTrayLabels } from '@/lib/invoke';
import { revealMainWindow } from '@/lib/window';

/**
 * A single hotplug or a device waking up reaches Core Audio as a burst of
 * notifications (added, then default, then state, then property). One
 * re-enumeration at the end of the burst is all the UI needs.
 */
const AUDIO_SYNC_DEBOUNCE_MS = 400;

/** Runs `task` once the browser is idle, falling back to a task tick. */
function afterFirstPaint(task: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(task, { timeout: 1000 });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(task, 0);
  return () => window.clearTimeout(handle);
}

export default function App() {
  const { t, i18n } = useTranslation();
  const refreshDevices = useRouterStore((s) => s.refreshDevices);
  const refreshSessions = useRouterStore((s) => s.refreshSessions);
  const loadDefaultDevice = useRouterStore((s) => s.loadDefaultDevice);
  const loadDelaySettings = useRouterStore((s) => s.loadDelaySettings);
  const loadDeviceVolumes = useRouterStore((s) => s.loadDeviceVolumes);
  const loadPrimaryVolumes = useRouterStore((s) => s.loadPrimaryVolumes);
  const loadSourceVolumes = useRouterStore((s) => s.loadSourceVolumes);
  const loadShellSettings = useRouterStore((s) => s.loadShellSettings);
  const autostart = useRouterStore((s) => s.autostart);
  const loadRememberedRoutes = useRouterStore((s) => s.loadRememberedRoutes);
  const loadFeeds = useRouterStore((s) => s.loadFeeds);
  const loadFeedCarrier = useRouterStore((s) => s.loadFeedCarrier);
  const loadCaptureDevices = useRouterStore((s) => s.loadCaptureDevices);
  const reconcileActiveDuplications = useRouterStore((s) => s.reconcileActiveDuplications);
  const loadStartupNotice = useRouterStore((s) => s.loadStartupNotice);
  const startupNotice = useRouterStore((s) => s.startupNotice);
  // Which surface and which tab: the store owns both, because the tray menu,
  // the error card and the briefing page all have to be able to move the user
  // from where they are standing.
  const view = useRouterStore((s) => s.view);
  const setView = useRouterStore((s) => s.setView);
  const tab = useRouterStore((s) => s.tab);
  const setTab = useRouterStore((s) => s.setTab);
  const unreadErrors = useRouterStore((s) => s.unreadErrors);
  const startupNoticeLoaded = useRouterStore((s) => s.startupNoticeLoaded);
  // The launch owns the work area until it is acknowledged: the first run of
  // this version line — a fresh install, or a machine walking in from anything
  // older — walks the user in, and the upgrade's tour carries the one screen
  // about the predecessor's settings. What that predecessor left pinned is one
  // more stop of the same tour, never a layer of its own.
  const wizardActive = startupNoticeLoaded && startupNotice !== null;

  useEffect(() => {
    // The window is created hidden so nobody sees the unstyled shell. This runs
    // after the first commit, i.e. once there is something real to show.
    //
    // A launch at sign-in carries --hidden, because a background tool that puts a
    // window in front of a user who did not ask for one is not background: the
    // tray is the way in from there.
    let cancelled = false;
    void isSilentLaunch()
      .catch((error) => {
        console.warn('[window] silent-launch check failed', error);
        return false;
      })
      .then((silent) => {
        if (!cancelled && !silent) void revealMainWindow();
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // Read before the first frame rather than with the deferred pass: the work
    // area does not draw until it knows whether this launch owes the user a
    // tour, and a read that waits for the idle callback leaves the window
    // showing a blank plane for a beat too long. It is a small file read on
    // the Rust side and touches no audio.
    void loadStartupNotice();
  }, [loadStartupNotice]);

  useEffect(() => {
    void loadDelaySettings();
    void loadDeviceVolumes();
    void loadPrimaryVolumes();
    void loadSourceVolumes();
  }, [loadDelaySettings, loadDeviceVolumes, loadPrimaryVolumes, loadSourceVolumes]);

  useEffect(() => {
    // The tray menu is a native control and cannot read i18next, so its labels
    // are pushed over whenever the UI language changes — and the startup item's
    // check mark with them, so the menu and the settings page never disagree
    // about the registry entry they both describe.
    void setTrayLabels({
      show: t('tray.show'),
      openSettings: t('tray.openSettings'),
      autostart: t('tray.autostart'),
      autostartChecked: autostart,
      stopAll: t('tray.stopAll'),
      quit: t('tray.quit'),
    }).catch((error) => {
      // A plain browser tab during `vite dev` has no tray at all.
      console.warn('[tray] could not set the menu labels', error);
    });
  }, [t, i18n.language, autostart]);

  // The tray's own work one press away: it names the action and no more, and
  // the state each one changes lives here — the routes in the store, the
  // startup entry's switch on the settings page, and the settings view itself.
  useBackendEvent<TrayMenuEvent>('tray-menu', ({ action }) => {
    const store = useRouterStore.getState();
    if (action === 'open-settings') store.setView('settings');
    else if (action === 'toggle-autostart') void store.toggleAutostart();
    else if (action === 'stop-all') void store.stopAllRoutes();
  });

  useEffect(() => {
    // Enumerating devices and sessions walks the Core Audio graph on the Rust
    // side, and every result appends a log entry. Running that during the first
    // render made the IPC round-trips and the extra re-renders compete with the
    // initial paint, so wait until the first frame is on screen. The system
    // default device is fetched alongside, since it is what a process is
    // associated with until it is routed somewhere explicitly.
    return afterFirstPaint(() => {
      void refreshDevices();
      void loadDefaultDevice();
      void refreshSessions();
      // Routes can outlast the process (the audio service persists them), so
      // on boot the backend may already be duplicating for some PIDs while the
      // store still thinks nothing is routed. Reconcile before first paint so
      // the badges match reality from the moment the window shows.
      void reconcileActiveDuplications();
      // The routes an earlier session wrote down. Loading them is also what
      // asks for them to be put back, so a program that is already playing when
      // the app starts is on its remembered device without the user doing
      // anything — which is the whole point of launching into the tray.
      void loadRememberedRoutes();
      // Feed rules and the carrier pair are the other remembered half of the
      // graph; the restore waits for the lists the same way routes do, and
      // whichever of the three inputs lands last calls it.
      void loadFeeds();
      void loadFeedCarrier();
      // Recording endpoints back the carrier picker in settings; they never
      // block anything on the board.
      void loadCaptureDevices();
      // The tray preference and the startup registry entry are only read by the
      // settings page, so they wait for the first paint like the rest.
      void loadShellSettings();
    });
  }, [
    refreshDevices,
    loadDefaultDevice,
    refreshSessions,
    reconcileActiveDuplications,
    loadRememberedRoutes,
    loadFeeds,
    loadFeedCarrier,
    loadCaptureDevices,
    loadShellSettings,
  ]);

  // Duplication engines report their end (user stop, process exit, error) through
  // this backend event so the badges stay honest.
  useBackendEvent<DuplicationStoppedEvent>('duplication-stopped', (payload) => {
    useRouterStore.getState().handleDuplicationStopped(payload);
  });

  // A single mirror that could not be opened leaves the rest of the route
  // running, so it is reported apart from the engine-level stop above.
  useBackendEvent<MirrorFailedEvent>('duplication-mirror-failed', (payload) => {
    useRouterStore.getState().handleMirrorFailed(payload);
  });

  // The tap that carries a feed into the carrier died. The programme's devices
  // are untouched — this is the other end of the wire — so it gets its own card
  // instead of the route's.
  useBackendEvent<FeedTapFailedEvent>('feed-tap-failed', (payload) => {
    useRouterStore.getState().handleFeedTapFailed(payload);
  });

  // An engine opens its mirror devices behind an asynchronous activation, so
  // this arrives after apply_route has already answered. It is the first moment
  // a latency reading exists for those devices.
  useBackendEvent<DuplicationReadyEvent>('duplication-ready', (payload) => {
    useRouterStore.getState().handleDuplicationReady(payload);
  });

  // A session flipping between playing and paused is not a list change, so it
  // rides its own channel: the routing board's liveness wants the transition
  // the moment it happens, not at the next re-enumeration.
  useBackendEvent<SessionActivityEvent>('session-activity', (payload) => {
    useRouterStore.getState().handleSessionActivity(payload);
  });

  // Core Audio says something moved — a device was plugged in, an app started or
  // stopped playing. React on a timer instead of per notification, and read the
  // store at fire time so a route applied during the wait is not overwritten.
  const pendingSync = useRef<AudioChangedEvent | null>(null);
  const syncTimer = useRef<number | null>(null);
  const queueAudioSync = useCallback((changed: AudioChangedEvent) => {
    // Two emits can straddle the debounce window; merge so neither half of what
    // they reported gets dropped by the later one.
    const merged = pendingSync.current ?? { devices: false, sessions: false };
    merged.devices = merged.devices || changed.devices;
    merged.sessions = merged.sessions || changed.sessions;
    pendingSync.current = merged;

    if (syncTimer.current !== null) window.clearTimeout(syncTimer.current);
    syncTimer.current = window.setTimeout(() => {
      syncTimer.current = null;
      const next = pendingSync.current;
      pendingSync.current = null;
      if (next) void useRouterStore.getState().syncFromNotification(next);
    }, AUDIO_SYNC_DEBOUNCE_MS);
  }, []);
  useBackendEvent<AudioChangedEvent>('audio-changed', queueAudioSync);

  useEffect(
    () => () => {
      if (syncTimer.current !== null) window.clearTimeout(syncTimer.current);
      pendingSync.current = null;
    },
    [],
  );

  // An icon ask that loses its race settles as a miss, and a miss gets a
  // bounded number of its own retries — after that only a refresh asks again.
  // On a quiet system nothing raises one, so a letter tile would hold for the
  // rest of the run. Each time the window comes to the front is one more ask:
  // not a poll, but a re-ask for whatever the user is actually looking at.
  useEffect(() => {
    const reAsk = () => useRouterStore.getState().loadMissingIcons();
    window.addEventListener('focus', reAsk);
    return () => window.removeEventListener('focus', reAsk);
  }, []);

  return (
    // One flat plane of colour behind everything. Every surface that sits on it
    // is solid and separated by hairlines, so the plane carries no detail of its
    // own — painted once, never repainted, behind every other layer including
    // the title bar, because the frame is part of the same window rather than a
    // thing stuck onto it.
    <div className="relative isolate flex h-screen flex-col overflow-hidden bg-bg-primary text-text-primary">
      <TitleBar
        settingsOpen={view === 'settings'}
        onToggleSettings={() => setView(view === 'settings' ? 'router' : 'settings')}
        hideSettings={wizardActive}
      />

      {/* Two planes, one hairline between them: the app list is a sidebar, and
          everything else is the work area. Entrance-only transitions (no
          AnimatePresence): the outgoing view unmounts immediately, which keeps
          the swap stuck-free. */}
      <div className="flex min-h-0 flex-1">
        {!startupNoticeLoaded ? (
          // The work area holds its breath for the one read that decides what
          // belongs in it. It is a file read on the Rust side, so this is a
          // frame or two — and a frame or two of nothing beats a flash of the
          // board that is about to be replaced by the tour.
          <div key="boot" className="min-h-0 flex-1" aria-busy="true" />
        ) : wizardActive ? (
          <motion.div
            key="wizard"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={FADE}
            transformTemplate={MAIN_THREAD_TRANSFORM}
            className="min-h-0 flex-1"
          >
            <StartupWizard />
          </motion.div>
        ) : view === 'router' ? (
          <motion.div
            key="router"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={FADE}
            transformTemplate={MAIN_THREAD_TRANSFORM}
            className="flex min-h-0 flex-1"
          >
            <aside className="w-[236px] flex-none border-r border-line">
              <ProgramRail />
            </aside>

            {/* The work area: one tab row, then whatever that tab shows. */}
            <main className="relative flex min-h-0 min-w-0 flex-1 flex-col">
              <UnderlineTabs
                ariaLabel={t('tabs.label')}
                layoutId="work-tab-rule"
                active={tab}
                onChange={(id) => setTab(id as WorkTab)}
                tabs={[
                  { id: 'router', label: t('tabs.router') },
                  { id: 'briefing', label: t('tabs.briefing') },
                  // The record's own dot: error lines written while it was closed
                  // are ones nobody has read, and a failure nobody saw is a
                  // failure nobody can act on.
                  {
                    id: 'activity',
                    label: (
                      <span className="relative">
                        {t('tabs.activity')}
                        {unreadErrors > 0 && (
                          <span
                            aria-hidden="true"
                            className="absolute -right-2.5 top-0 h-1.5 w-1.5 rounded-full bg-error"
                          />
                        )}
                      </span>
                    ),
                  },
                ]}
              />
              {/*
                  The tab's content arrives on the same entrance-only spring the
                  top-level views and the settings sections ride: keyed by the
                  tab so a switch replays it, and no exit — the outgoing view
                  unmounts at once, which keeps the swap stuck-free. */}
              <motion.div
                key={tab}
                role="tabpanel"
                id={tabPanelId('work-tab-rule', tab)}
                aria-labelledby={tabButtonId('work-tab-rule', tab)}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={SPRING_GLIDE}
                transformTemplate={MAIN_THREAD_TRANSFORM}
                className="flex min-h-0 flex-1 flex-col"
              >
                {tab === 'router' ? (
                  <>
                    <NodeStage />
                    {/* Every live route at once, each with its own way out —
                        stop only; starting belongs to the hub. */}
                    <RoutedCapsule />
                  </>
                ) : tab === 'briefing' ? (
                  <BriefingPage />
                ) : (
                  <LogPanel />
                )}
              </motion.div>
            </main>
          </motion.div>
        ) : (
          <motion.div
            key="settings"
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            transition={SPRING_GLIDE}
            transformTemplate={MAIN_THREAD_TRANSFORM}
            className="min-h-0 flex-1"
          >
            <SettingsPage onBack={() => setView('router')} />
          </motion.div>
        )}
      </div>

      {/* Last children, so they cover both views: the standing offer to undo
          the route that was just applied. Everything a launch owes the user —
          the tour, the predecessor-settings question, the endpoint cleanup —
          is a stop of that tour in the work area, not a layer here. */}
      <Toast />
    </div>
  );
}
