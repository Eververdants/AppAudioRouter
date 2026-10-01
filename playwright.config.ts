import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests (Playwright) against the Vite dev server.
 *
 * The app is a desktop window, but everything a user does to it happens in the
 * webview: the same React tree, the same store, the same Tauri IPC. The IPC is
 * replaced by the fake runtime in `e2e/tauri/bridge.ts`, so these specs need no
 * Rust backend, no audio devices and no Windows — which is what lets them run
 * on every push in CI.
 */
export default defineConfig({
  testDir: './e2e',
  // Each spec boots its own page and its own backend; nothing is shared.
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // A browser receiving an event a beat late is worth one more attempt, never
  // a flaky failure — but only where nobody is watching the run live.
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:1420',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 860 },
    // The app follows the OS theme; pin it so a run does not depend on the
    // machine it ran on.
    colorScheme: 'light',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm dev --port 1420',
    url: 'http://localhost:1420',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
