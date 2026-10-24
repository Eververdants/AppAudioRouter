/**
 * The remembered routes: what the app will re-apply on the next boot, and the
 * half of the tour that says "start clean". Mirrors
 * `src-tauri/src/commands/memory.rs` — keyed by executable, never by display name.
 *
 * Runs **inside the page**, after the core, and closes over nothing from this
 * module.
 */
export function registerMemoryCommands(): void {
  const { state, handlers } = window.__AAR_BRIDGE__;

  handlers.set('get_remembered_routes', () => state.remembered);
  handlers.set('clear_route', (payload) => {
    state.remembered = state.remembered.filter(
      ([name]: [string, string[]]) => name !== payload.exeName,
    );
    return null;
  });
  handlers.set('forget_previous_settings', () => {
    // `commands/memory.rs`: five files, and deliberately nothing else — the
    // per-app endpoint assignments belong to the release reset (it reaches
    // what the user set by hand), the primary volumes are the program's own
    // session volume, and close-to-tray with the startup entry are habits.
    state.remembered = [];
    state.feeds = [];
    state.delays = [];
    state.volumes = [];
    state.sourceVolumes = [];
    return null;
  });
}
