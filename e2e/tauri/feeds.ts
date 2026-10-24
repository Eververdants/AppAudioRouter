import type { BridgeSession } from './types';

/**
 * Sending one program's output into another's input, and the loopback pair that
 * carries them. Mirrors `src-tauri/src/commands/feeds.rs`.
 *
 * Runs **inside the page**, after the core, and closes over nothing from this
 * module.
 */
export function registerFeedCommands(): void {
  const { state, handlers } = window.__AAR_BRIDGE__;

  handlers.set('get_feed_carrier', () => state.feedCarrier);
  handlers.set('set_feed_carrier', (payload) => {
    state.feedCarrier = {
      render: (payload.render as string | null) ?? null,
      capture: (payload.capture as string | null) ?? null,
    };
    return null;
  });
  handlers.set('list_feeds', () => state.feeds);
  handlers.set('set_feed_target', (payload) => {
    const sourceExe = payload.sourceExe as string;
    const targetExe = payload.targetExe as string;
    if (!state.feeds.some(([s, t]: [string, string]) => s === sourceExe && t === targetExe)) {
      state.feeds = [...state.feeds, [sourceExe, targetExe]];
    }
    const configured = state.feedCarrier.render !== null && state.feedCarrier.capture !== null;
    if (!configured) return { delivered: false, reason: 'no_carrier' };
    // A feed is the engine's tap into the carrier, so a device route
    // alongside it changes nothing: only a missing carrier blocks delivery.
    return { delivered: true, reason: null };
  });
  handlers.set('remove_feed_target', (payload) => {
    // The real command addresses the two ends by PID (the toggle already
    // knows the sessions); the fake maps back to the exe names its memory
    // is keyed by.
    const sourceExe = state.sessions.find(
      (s: BridgeSession) => s.pid === payload.sourcePid,
    )?.exe_name;
    const targetExe = state.sessions.find(
      (s: BridgeSession) => s.pid === payload.targetPid,
    )?.exe_name;
    state.feeds = state.feeds.filter(
      ([s, t]: [string, string]) =>
        !(
          s.toLowerCase() === (sourceExe ?? '').toLowerCase() &&
          t.toLowerCase() === (targetExe ?? '').toLowerCase()
        ),
    );
    // Nothing stays pinned in the fake: it has no endpoint books.
    return [];
  });
}
