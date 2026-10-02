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

/** Two programs routed: Music to three devices (the headset it was already on,
 *  plus two wired outputs held back so all three arrive together), and Chrome
 *  to the digital output. That is what the board is for — seeing where every
 *  sound is going at once — so the shot has to show more than one source line.
 *  The rest of the hardware is there and deliberately not part of any route, so
 *  the shot also shows where the routed block ends. Both routed programs are
 *  marked as playing, because that is the board's resting truth when music is
 *  on: the wires carry their moving dash. The list is filled out to a plausible
 *  desktop rather than trimmed to two rows: a screenshot that is nine tenths
 *  empty white reads as a broken layout, not as a quiet one. */
const STATE = {
  devices: [
    { id: 'bt', name: 'WH-1000XM5' },
    { id: 'hdmi', name: 'HDMI output' },
    { id: 'usb', name: 'USB headphones' },
    { id: 'spk', name: 'Speakers (Realtek)' },
    { id: 'spdif', name: 'Digital Audio (S/PDIF)' },
    { id: 'nv', name: 'NVIDIA High Definition Audio' },
  ],
  sessions: [
    { pid: 4021, exe_name: 'Music.exe', playing: true },
    { pid: 5233, exe_name: 'chrome.exe', playing: true },
    { pid: 6180, exe_name: 'Game.exe' },
    { pid: 7102, exe_name: 'Discord.exe' },
    { pid: 8401, exe_name: 'spotify.exe' },
    { pid: 7500, exe_name: 'Code.exe' },
    { pid: 9102, exe_name: 'steam.exe' },
    { pid: 6601, exe_name: 'vlc.exe' },
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
  sourceVolumes: [
    ['Music.exe', 80],
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

    // A second program to a second output, so the board shows a fan of routes
    // instead of one: the shot is of the board, not of a single route.
    await appRow(page, 'chrome.exe').click();
    await deviceRow(page, 'Digital Audio (S/PDIF)').click();
    await routeConfirmButton(page).click();

    // Let the undo offer expire: the shot is of the resting state, not of the
    // moment after the click.
    await expect(page.getByRole('button', { name: 'Undo' })).toBeHidden({ timeout: 15_000 });

    await page.screenshot({ path: `docs/images/app-audio-router-${theme}.png` });
  });
}
