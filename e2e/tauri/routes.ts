/**
 * Applying a route and stopping one: the per-app endpoint, and the engine a
 * second device starts. Mirrors `src-tauri/src/commands/routes.rs`.
 *
 * The generation this domain hands out is the fact the rest of the fake reads
 * before it reports anything about an engine — `get_active_duplications` will not
 * invent a latency for a run that has not said it is ready, and `deliver` will not
 * believe a `duplication-ready` that names a generation the route no longer holds.
 *
 * Runs **inside the page**, after the core, and closes over nothing from this
 * module.
 */
export function registerRouteCommands(): void {
  const { state, handlers } = window.__AAR_BRIDGE__;

  handlers.set('apply_route', (payload) => {
    const pid = String(payload.pid);
    const deviceIds = [...(payload.deviceIds as string[])];
    state.routes[pid] = deviceIds;
    // The real command starts an engine only when there are copies; a
    // single-device route is just the per-app endpoint and reports 0.
    if (deviceIds.length <= 1) {
      delete state.routeGenerations[pid];
      delete state.readyGenerations[pid];
      return 0;
    }
    state.generation += 1;
    state.routeGenerations[pid] = state.generation;
    // A new engine has not opened its mirrors yet, so it has no reading to
    // report until it says it is ready.
    delete state.readyGenerations[pid];
    return state.generation;
  });
  handlers.set('stop_route', (payload) => {
    delete state.routes[String(payload.pid)];
    delete state.routeGenerations[String(payload.pid)];
    delete state.readyGenerations[String(payload.pid)];
    return { released: true, pinned_device: null, sibling_held: false };
  });
}
