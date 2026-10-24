import type { BridgeDevice } from './types';

/**
 * What is out there on the machine: the endpoints, the sessions, the apps with a
 * window, the icon for one executable, and the engines whose latency the board
 * reads. Mirrors `src-tauri/src/commands/discovery.rs`, down to
 * `get_active_duplications` living here rather than with the routes — it is a
 * read of what exists, even though the books it reports are the ones `apply_route`
 * wrote.
 *
 * Runs **inside the page**, after the core, and closes over nothing from this
 * module: the books its command bodies read come off `window.__AAR_BRIDGE__`, and
 * nothing else crosses the serialization boundary.
 */
export function registerDiscoveryCommands(): void {
  const { state, handlers } = window.__AAR_BRIDGE__;

  handlers.set('list_devices', () => state.devices);
  handlers.set('list_sessions', () => state.sessions);
  handlers.set('get_process_icon', (payload) => {
    // A deterministic tile hashed from the executable name, so the specs
    // exercise the real RGBA→data-URL path without binary fixtures. An
    // unknown pid reads as "no icon", the way a dead process would.
    const session = state.sessions.find((s) => s.pid === Number(payload.pid));
    if (session === undefined) return null;
    let hash = 0;
    for (const ch of session.exe_name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    const rgba = new Uint8ClampedArray(8 * 8 * 4);
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = hash & 0xff;
      rgba[i + 1] = (hash >> 8) & 0xff;
      rgba[i + 2] = (hash >> 16) & 0xff;
      rgba[i + 3] = 255;
    }
    return { width: 8, height: 8, rgba: btoa(String.fromCharCode(...rgba)) };
  });
  handlers.set(
    'get_default_device',
    () =>
      state.devices.find((d: BridgeDevice) => d.id === state.defaultDeviceId) ?? state.devices[0],
  );
  handlers.set('list_capture_devices', () => state.captureDevices);
  handlers.set('list_window_apps', () => state.windowApps);
  handlers.set('get_active_duplications', () => {
    // The real command lists *engines*, so single-device routes — which
    // have none — never appear here. Parallel arrays, same order as the
    // real engine reports them: the primary has no stream of ours to ask,
    // so its entry is `null` — the same "not measured" the real backend
    // sends for it, and for the copies too until the engine whose
    // generation reported `duplication-ready` is still the live one.
    return Object.entries(state.routes)
      .filter(([, deviceIds]) => deviceIds.length > 1)
      .map(([pid, deviceIds]) => ({
        pid: Number(pid),
        generation: state.routeGenerations[pid] ?? 0,
        deviceIds,
        latencyMs: deviceIds.map((_, index) =>
          index === 0 || state.readyGenerations[pid] !== state.routeGenerations[pid] ? null : 20,
        ),
      }));
  });
}
