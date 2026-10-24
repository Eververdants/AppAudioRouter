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
    const pid = Number(payload.pid);
    const exeName = String(payload.exeName ?? '');
    const requested = [...(payload.deviceIds as string[])];
    // The boundary of `commands/routes.rs`, word for word: pid 0 is the
    // system-sounds session, a nameless route has nothing to be remembered
    // under, an empty list is not a route, and a device named twice is a
    // mirror on the device the OS already plays natively — so the repeat is
    // dropped where it first appeared, which is also what decides the primary.
    if (pid === 0) throw new Error('a route needs a process');
    if (exeName.trim() === '') throw new Error('a route needs the program it applies to');
    if (requested.length === 0) throw new Error('no devices selected');
    const deviceIds = requested.filter((id, index) => requested.indexOf(id) === index);
    state.routes[String(pid)] = deviceIds;
    // The real command starts an engine only when there are copies; a
    // single-device route is just the per-app endpoint and reports 0.
    if (deviceIds.length <= 1) {
      delete state.routeGenerations[pid];
      delete state.readyGenerations[pid];
    } else {
      state.generation += 1;
      state.routeGenerations[pid] = state.generation;
      // A new engine has not opened its mirrors yet, so it has no reading to
      // report until it says it is ready.
      delete state.readyGenerations[pid];
    }
    // `if remember { config.save_route(...) }`, after the landing has taken:
    // one entry per executable, the new list replacing the old, the rest of
    // the book untouched — what a later boot restores from and what the
    // settings page lists and forgets.
    if (payload.remember === true) {
      state.remembered = [
        ...state.remembered.filter(([name]: [string, string[]]) => name !== exeName),
        [exeName, deviceIds],
      ];
    }
    return deviceIds.length <= 1 ? 0 : state.generation;
  });
  handlers.set('stop_route', (payload) => {
    delete state.routes[String(payload.pid)];
    delete state.routeGenerations[String(payload.pid)];
    delete state.readyGenerations[String(payload.pid)];
    // `released: true` is the only answer this graph can honestly give: the
    // release the real command performs is answered by Windows, and the fake's
    // Windows is the scripted graph, which never refuses. The outcome shape
    // with `released: false` is covered where the decision is made — the
    // store's own suite injects `StopOutcome`s through its harness — so an
    // e2e knob to fake a refusal would test the knob, not the product.
    return { released: true, pinned_device: null, sibling_held: false };
  });
}
