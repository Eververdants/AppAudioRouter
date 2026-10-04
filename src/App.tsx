import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { ConcentricStage } from '@/components/ConcentricStage';
import { LogPanel } from '@/components/LogPanel';
import { ProgramRail } from '@/components/ProgramRail';
import { SettingsPage } from '@/components/SettingsPage';
import { StartupNoticeDialog } from '@/components/StartupNoticeDialog';
import { StatusBriefing } from '@/components/StatusBriefing';
import { TitleBar } from '@/components/TitleBar';
import { Toast } from '@/components/Toast';
import { UnderlineTabs } from '@/components/ui/UnderlineTabs';
import { useBackendEvent } from '@/hooks/useBackendEvent';
import { useGlassSpecular } from '@/hooks/useGlassSpecular';
import { useRouterStore } from '@/stores/routerStore';
import type {
  AudioChangedEvent,
  DuplicationReadyEvent,
  DuplicationStoppedEvent,
  MirrorFailedEvent,
  SessionActivityEvent,
} from '@/lib/types';
import { FADE, SPRING_GLIDE } from '@/lib/motion';
import { applyGlassLite, readStoredGlassLite, resolveGlassLite } from '@/lib/glassLite';
import { isSilentLaunch, setTrayLabels } from '@/lib/invoke';
import { revealMainWindow } from '@/lib/window';

/**
 * A single hotplug or a device waking up reaches Core Audio as a burst of
 * notifications (added, then default, then state, then property). One
 * re-enumeration at the end of the burst is all the UI needs.
 */
const AUDIO_SYNC_DEBOUNCE_MS = 400;

/** The two things the work area can show. */
type WorkTab = 'router' | 'activity';

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
  const loadRememberedRoutes = useRouterStore((s) => s.loadRememberedRoutes);
  const reconcileActiveDuplications = useRouterStore((s) => s.reconcileActiveDuplications);
  const loadStartupNotice = useRouterStore((s) => s.loadStartupNotice);
  const [view, setView] = useState<'router' | 'settings'>('router');
  const [tab, setTab] = useState<WorkTab>('router');

  // The glass catches the pointer: one delegated listener writes the hovered
  // pane's highlight position, so every lens in the window tracks the light.
  useGlassSpecular();

  useEffect(() => {
    // The boot script in index.html already applied low-spec glass before the
    // first paint. This keeps following the machine's verdict while the user
    // has made none of their own — flipping Windows' transparency effects
    // takes effect without a relaunch. A stored choice always wins, so the
    // check lives in the handler, not in the effect body.
    const media = window.matchMedia('(prefers-reduced-transparency: reduce)');
    const onChange = () => {
      if (readStoredGlassLite() === null) applyGlassLite(resolveGlassLite());
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

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
    void loadDelaySettings();
    void loadDeviceVolumes();
    void loadPrimaryVolumes();
    void loadSourceVolumes();
  }, [loadDelaySettings, loadDeviceVolumes, loadPrimaryVolumes, loadSourceVolumes]);

  useEffect(() => {
    // The tray menu is a native control and cannot read i18next, so its labels
    // are pushed over whenever the UI language changes.
    void setTrayLabels(t('tray.show'), t('tray.quit')).catch((error) => {
      // A plain browser tab during `vite dev` has no tray at all.
      console.warn('[tray] could not set the menu labels', error);
    });
  }, [t, i18n.language]);

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
      // The tray preference and the startup registry entry are only read by the
      // settings page, so they wait for the first paint like the rest.
      void loadShellSettings();
      // Whether this install is fresh or an update, and what to say about the
      // assignments an earlier version may have left behind.
      void loadStartupNotice();
    });
  }, [
    refreshDevices,
    loadDefaultDevice,
    refreshSessions,
    reconcileActiveDuplications,
    loadRememberedRoutes,
    loadShellSettings,
    loadStartupNotice,
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

  return (
    // One wash of light behind everything, blurred past legibility. It exists so
    // the glass panels have something to refract — a blur over a flat colour is
    // grey plastic, and this app is made of glass. Painted once, never animated,
    // and behind every other layer including the title bar, because the frame is
    // part of the same window rather than a thing stuck onto it.
    <div className="relative isolate flex h-screen flex-col overflow-hidden bg-bg-primary text-text-primary">
      <div aria-hidden="true" className="aurora pointer-events-none absolute inset-0 -z-10" />
      {/* A breath of grain over that wash, so the light reads as falling on a
          surface rather than as a flat vector gradient. Static and blended. */}
      <div aria-hidden="true" className="grain pointer-events-none absolute inset-0 -z-10" />

      <TitleBar
        settingsOpen={view === 'settings'}
        onToggleSettings={() => setView((v) => (v === 'settings' ? 'router' : 'settings'))}
      />

      {/* Two planes, one hairline between them: the app list is a sidebar, and
          everything else is the work area. Entrance-only transitions (no
          AnimatePresence): the outgoing view unmounts immediately, which keeps
          the swap stuck-free. */}
      <div className="flex min-h-0 flex-1">
        {view === 'router' ? (
          <motion.div
            key="router"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={FADE}
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
                  { id: 'activity', label: t('tabs.activity') },
                ]}
              />
              {tab === 'router' ? (
                <>
                  <ConcentricStage />
                  {/* The plain-language answer to "where is sound going", in
                      the corner the action dock used to float over. */}
                  <StatusBriefing />
                </>
              ) : (
                <LogPanel />
              )}
            </main>
          </motion.div>
        ) : (
          <motion.div
            key="settings"
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            transition={SPRING_GLIDE}
            className="min-h-0 flex-1"
          >
            <SettingsPage onBack={() => setView('router')} />
          </motion.div>
        )}
      </div>

      {/* Last children, so they cover both views: what this install is told
          about itself once (a welcome, or the leftovers of an earlier version),
          and the standing offer to undo the route that was just applied. */}
      <StartupNoticeDialog />
      <Toast />
    </div>
  );
}
