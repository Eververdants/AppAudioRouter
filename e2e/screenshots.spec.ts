import { expect, test } from '@playwright/test';
import { addDevice, appRow, hub, tuneButton } from './fixtures';
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

/** One programme routed to three devices at once — the case the stage is for,
 *  and the only one in which a delay or a level has anything to act on: the
 *  copies carry the numbered badges that open the tuning strip. Chrome goes to
 *  the digital output as well, so the rail shows two programmes with somewhere
 *  to be. The rest of the hardware is deliberately not part of any route, so
 *  the shot also shows where the plan stops and the dashed "add destination"
 *  card begins. Both routed programmes are marked as playing, because that is
 *  the resting truth when music is on: the wires carry their moving dash. The list is filled out to a plausible desktop rather
 *  than trimmed to two rows: a screenshot that is nine tenths empty reads as a
 *  broken layout, not as a quiet one. */
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
    { pid: 4021, exe_name: 'Music.exe', display_name: 'Music', playing: true },
    { pid: 5233, exe_name: 'chrome.exe', display_name: 'Google Chrome', playing: true },
    { pid: 6180, exe_name: 'Game.exe', display_name: 'Game' },
    { pid: 7102, exe_name: 'Discord.exe', display_name: 'Discord' },
    { pid: 8401, exe_name: 'spotify.exe', display_name: 'Spotify' },
    { pid: 7500, exe_name: 'Code.exe', display_name: 'Visual Studio Code' },
    { pid: 9102, exe_name: 'steam.exe', display_name: 'Steam' },
    { pid: 6601, exe_name: 'vlc.exe', display_name: 'VLC media player' },
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
  captureDevices: [{ id: 'cable-out', name: 'CABLE Output (VB-Audio)' }],
  feedCarrier: { render: 'spdif', capture: 'cable-out' },
  feeds: [] as [string, string][],
};

for (const theme of ['light', 'dark'] as const) {
  test(`capture the ${theme} theme`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });

    await installBridge(page, STATE);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Apps' })).toBeVisible();
    await expect(page.getByText('Music.exe').first()).toBeVisible();

    // Selecting the app stages the system default device, which is a guess the
    // app made — so the first click on another device replaces it rather than
    // adding to it, and every click after that adds. Two wired outputs and the
    // headset, which is what puts a delay and a level under the two copies.
    await appRow(page, 'Music.exe').click();
    await addDevice(page, 'HDMI output');
    await addDevice(page, 'WH-1000XM5');
    await addDevice(page, 'USB headphones');
    await hub(page).click();

    // A second programme to a second output, so the rail shows two of them with
    // somewhere to be rather than one.
    await appRow(page, 'chrome.exe').click();
    await addDevice(page, 'Digital Audio (S/PDIF)');
    await hub(page).click();

    // Back to the three-device programme with one copy's strip open: the shot
    // shows the board and the levers a copy actually has.
    await appRow(page, 'Music.exe').click();
    await tuneButton(page, 'HDMI output').click();

    // Let the undo offer expire: the shot is of the resting state, not of the
    // moment after the click.
    await expect(page.getByRole('button', { name: 'Undo' })).toBeHidden({ timeout: 15_000 });

    await page.screenshot({ path: `docs/images/app-audio-router-${theme}.png` });
  });
}
