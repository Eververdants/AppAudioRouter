/**
 * The shell around the window: the tray's words, autostart, the close-to-tray
 * setting, and the startup notice a first run is shown. Mirrors
 * `src-tauri/src/commands/shell.rs`.
 *
 * Every one of these answers the neutral value, because none of them is what a
 * spec is testing: the app's own state for them comes from `app-settings.json`
 * and localStorage, and a fake that refused would put a complaint on the screen
 * in the middle of an unrelated test.
 *
 * Runs **inside the page**, after the core, and closes over nothing from this
 * module.
 */
export function registerShellCommands(): void {
  const { handlers } = window.__AAR_BRIDGE__;

  handlers.set('set_tray_labels', () => null);
  handlers.set('ack_startup_notice', () => null);
  handlers.set('set_autostart', () => null);
  handlers.set('set_close_to_tray', () => null);
  handlers.set('get_close_to_tray', () => false);
  handlers.set('get_autostart', () => false);
  handlers.set('is_silent_launch', () => false);
  handlers.set('get_startup_notice', () => null);
}
