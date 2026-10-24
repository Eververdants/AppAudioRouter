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
  const { MAX_DEVICE_ID_LEN } = window.__AAR_CONSTANTS__;

  /** `audio::routing::validate_device_id`: non-empty, and under the length
   *  bound — copied word for word so a refusal here reads like the real one. */
  const validateDeviceId = (id: string): void => {
    if (id.length === 0) throw new Error('empty device id');
    if (id.length > MAX_DEVICE_ID_LEN) throw new Error('device id too long');
  };

  handlers.set('get_feed_carrier', () => state.feedCarrier);
  handlers.set('set_feed_carrier', (payload) => {
    const render = (payload.render as string | null) ?? null;
    const capture = (payload.capture as string | null) ?? null;
    // `set_feed_carrier`: each half that is present is validated, and a pair
    // pointed at one endpoint twice is refused — a carrier like that can be
    // configured but can never carry a feed.
    if (render !== null) validateDeviceId(render);
    if (capture !== null) validateDeviceId(capture);
    if (render !== null && capture !== null && render.toLowerCase() === capture.toLowerCase()) {
      throw new Error('the two halves of a loopback pair are different endpoints');
    }
    state.feedCarrier = { render, capture };
    return null;
  });
  handlers.set('list_feeds', () => state.feeds);
  handlers.set('set_feed_target', (payload) => {
    const sourcePid = Number(payload.sourcePid);
    const targetPid = Number(payload.targetPid);
    const sourceExe = String(payload.sourceExe);
    const targetExe = String(payload.targetExe);
    // `set_feed_target`'s boundary, in its own order and its own words.
    if (sourcePid === 0 || targetPid === 0 || sourcePid === targetPid) {
      throw new Error('a feed needs two distinct processes');
    }
    if (sourceExe.toLowerCase() === targetExe.toLowerCase()) {
      throw new Error('a program cannot be fed into itself');
    }
    if (sourceExe.trim().length === 0) {
      throw new Error('the sending program of a feed needs the program it applies to');
    }
    if (targetExe.trim().length === 0) {
      throw new Error('the receiving program of a feed needs the program it applies to');
    }
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
    const sourcePid = Number(payload.sourcePid);
    const targetPid = Number(payload.targetPid);
    if (sourcePid === 0 || targetPid === 0) {
      throw new Error('a feed needs two real processes');
    }
    const sourceExe = state.sessions.find((s: BridgeSession) => s.pid === sourcePid)?.exe_name;
    const targetExe = state.sessions.find((s: BridgeSession) => s.pid === targetPid)?.exe_name;
    if (sourceExe === undefined || targetExe === undefined) {
      // The real command refuses when neither the pins nor the process can
      // name the rule — answering `Ok` would report a removal that did not
      // happen, and the memory would go on resurrecting the feed.
      throw new Error(
        `the program behind this feed (PID ${sourcePid} in, PID ${targetPid} out) is gone, ` +
          'so its rule cannot be found to be forgotten — clear the remembered feed instead',
      );
    }
    state.feeds = state.feeds.filter(
      ([s, t]: [string, string]) =>
        !(
          s.toLowerCase() === sourceExe.toLowerCase() && t.toLowerCase() === targetExe.toLowerCase()
        ),
    );
    // Nothing stays pinned in the fake: it has no endpoint books.
    return [];
  });
}
