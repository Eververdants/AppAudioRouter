import { expect, test } from '@playwright/test';
import { appRow, deviceRow, routeConfirmButton } from './fixtures';
import { installBridge } from './tauri/bridge';

/**
 * The two README screenshots, captured from the app itself.
 *
 * On demand only: the images are checked in, so rewriting them belongs to the
 * change that alters the interface, not to every test run.
 *
 *   CAPTURE_SCREENSHOTS=1 pnpm exec playwright test e2e/screenshots.spec.ts
 *
 * The audio graph is the same fake runtime the specs use, so the shot does not
 * depend on what is plugged into the machine that took it — the device names in
 * it are scripted, and the route is applied through the real UI rather than
 * poked into the store.
 */

const ENABLED = process.env.CAPTURE_SCREENSHOTS === '1';

/** The default window size, at 2× for a screen that is not a retina one. */
test.use({ viewport: { width: 900, height: 680 }, deviceScaleFactor: 2 });

test.skip(
  !ENABLED,
  'README screenshots are captured on demand: CAPTURE_SCREENSHOTS=1 playwright test e2e/screenshots.spec.ts',
);

/** One program routed to three devices: the headset it was already on, plus two
 * wired outputs held back so all three arrive together. */
const STATE = {
  devices: [
    { id: 'bt', name: 'WH-1000XM5' },
    { id: 'hdmi', name: 'HDMI output' },
    { id: 'usb', name: 'USB headphones' },
  ],
  sessions: [
    { pid: 4021, exe_name: 'Music.exe' },
    { pid: 5233, exe_name: 'chrome.exe' },
    { pid: 6180, exe_name: 'Game.exe' },
  ],
  defaultDeviceId: 'bt',
  remembered: [],
  delays: [
    ['hdmi', 180],
    ['usb', 140],
  ],
  volumes: [
    ['hdmi', 70],
    ['usb', 85],
  ],
};

for (const theme of ['light', 'dark'] as const) {
  test(`capture the ${theme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    // The expert columns carry the delay and volume values the README talks
    // about, and they are off until the advanced switch says otherwise.
    await page.addInitScript(() => window.localStorage.setItem('aar-advanced-mode', '1'));

    await installBridge(page, STATE);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Apps' })).toBeVisible();
    await expect(page.getByText('Music.exe').first()).toBeVisible();

    // Selecting the app stages the system default device, and the first click
    // on another device replaces that guess rather than adding to it — so the
    // click is undone first, which is what leaves the headset as the primary
    // and the two wired outputs as the copies.
    await appRow(page, 'Music.exe').click();
    await deviceRow(page, 'HDMI output').click();
    await deviceRow(page, 'HDMI output').click();
    await deviceRow(page, 'WH-1000XM5').click();
    await deviceRow(page, 'HDMI output').click();
    await deviceRow(page, 'USB headphones').click();
    await routeConfirmButton(page).click();

    // Let the undo offer expire: the shot is of the resting state, not of the
    // moment after the click.
    await expect(page.getByRole('button', { name: 'Undo' })).toBeHidden({ timeout: 15_000 });

    await page.screenshot({ path: `docs/images/app-audio-router-${theme}.png` });
  });
}
