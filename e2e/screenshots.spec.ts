import { expect, test } from '@playwright/test';
import { addDevice, appRow, changePrimary, hub, tuneButton, tunerStrip } from './fixtures';
import { installBridge, type BridgeState } from './tauri/bridge';

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

/** The default window size (`tauri.conf.json`), at 2× for a screen that is
 *  not a retina one. */
test.use({ viewport: { width: 980, height: 720 }, deviceScaleFactor: 2 });

test.skip(
  !ENABLED,
  'README screenshots are captured on demand: CAPTURE_SCREENSHOTS=1 playwright test e2e/screenshots.spec.ts',
);

/** One programme routed to three devices at once — the case the stage is for,
 *  and the only one in which a delay or a level has anything to act on: the
 *  copies carry the numbered badges that open the tuning strip. Chrome goes to
 *  the built-in speakers as well, so the rail shows two programmes with somewhere
 *  to be. The rest of the hardware is deliberately not part of any route, so
 *  the shot also shows where the plan stops and the dashed "add destination"
 *  card begins. Both routed programmes are marked as playing, because that is
 *  the resting truth when music is on: the wires carry their moving dash. The list is filled out to a plausible desktop rather
 *  than trimmed to two rows: a screenshot that is nine tenths empty reads as a
 *  broken layout, not as a quiet one. Typed as `BridgeState` so a field added to
 *  the fake cannot be quietly missing here — an absent `primaryVolumes` made the
 *  boot read throw, and nothing in a skipped file would ever have said so. */
const STATE: BridgeState = {
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
  sourceVolumes: [['Music.exe', 80]],
  primaryVolumes: [],
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
    await expect(appRow(page, 'Music.exe')).toBeVisible();

    // Selecting the programme stages the system default device as the seat, so
    // the shot's route is the headset plus the two wired outputs it is copied
    // to — which is what puts a delay and a share under the two copies. Only
    // the dashed card adds, and it never lists a device the plan already holds
    // (nor the carrier's playback side, 'spdif'), so every name below is one
    // that the picker really hands out.
    await appRow(page, 'Music.exe').click();
    await addDevice(page, 'HDMI output');
    await addDevice(page, 'USB headphones');
    await hub(page).click();

    // A second programme, on one output of its own, so the rail shows two of
    // them with somewhere to be rather than one. Named through the seat's
    // picker: it replaces the staged guess instead of piling a copy on it.
    await appRow(page, 'chrome.exe').click();
    await changePrimary(page, 'WH-1000XM5', 'Speakers (Realtek)');
    await hub(page).click();
    // The offer is up, so the wait below is a wait for it to expire rather than
    // a check of a button that was never there: `toBeHidden` is just as pleased
    // with an element that does not exist.
    await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();

    // Back to the three-device programme with one copy's strip open: the shot
    // shows the board and the levers a copy actually has.
    await appRow(page, 'Music.exe').click();
    await tuneButton(page, 'HDMI output').click();
    await expect(tunerStrip(page).getByText('Delay')).toBeVisible();

    // Let the undo offer expire: the shot is of the resting state, not of the
    // moment after the click.
    await expect(page.getByRole('button', { name: 'Undo' })).toBeHidden({ timeout: 15_000 });

    await page.screenshot({ path: `docs/images/app-audio-router-${theme}.png` });
  });
}
