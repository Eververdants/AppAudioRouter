/**
 * Handing back per-app endpoint assignments this run is not using. Mirrors
 * `src-tauri/src/commands/release.rs`.
 *
 * Nothing is swept here rather than refused because the scripted graph keeps no
 * endpoint books: every stop in `./routes.ts` already released what it held, and
 * there is no boot-time residue to find.
 *
 * Runs **inside the page**, after the core, and closes over nothing from this
 * module.
 */
export function registerReleaseCommands(): void {
  const { handlers } = window.__AAR_BRIDGE__;

  handlers.set('release_stale_routes', () => []);
  handlers.set('reset_pinned_endpoints', () => {
    // Nothing is left pinned in the scripted graph: every stop above
    // releases, and there is no boot-time residue to sweep.
    return { released: 0, still_pinned: [], still_pinned_devices: [] };
  });
}
