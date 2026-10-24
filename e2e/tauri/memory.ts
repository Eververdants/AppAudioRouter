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
}
