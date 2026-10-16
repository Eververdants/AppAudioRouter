import { expect, test } from '@playwright/test';
import { callsFor, emit, openApp, setDevices } from './fixtures';
import type { BridgeDevice } from './tauri/bridge';

/**
 * The settings page's one custom control: the feed carrier's endpoint pickers.
 *
 * It is the app's only combobox, and the list behind it is whatever the machine
 * has — past a handful of endpoints the menu scrolls, which is where a keyboard
 * highlight stops being reachable by itself, and where a device unplugged
 * mid-walk stops being a row at all.
 */

const MANY_DEVICES: BridgeDevice[] = Array.from({ length: 8 }, (_, i) => ({
  id: `dev-${i}`,
  name: `Device ${i + 1}`,
}));

/**
 * Open the playback-side picker and hand back its trigger.
 *
 * The pointer is parked afterwards on purpose: a row sliding under a cursor
 * that still sits on the menu takes the highlight back (`onMouseEnter`), and
 * these two specs are about the keyboard.
 */
async function openCarrierPicker(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Routing' }).click();
  const combo = page.getByRole('combobox', { name: 'Playback side' });
  await combo.click();
  await page.mouse.move(4, 4);
  return combo;
}

/** The row the trigger names with `aria-activedescendant`. */
async function highlighted(page: import('@playwright/test').Page, combo: {
  getAttribute(name: string): Promise<string | null>;
}) {
  const activeId = await combo.getAttribute('aria-activedescendant');
  expect(activeId, 'an open combobox names the row it is on').not.toBeNull();
  return page.locator(`[id="${activeId}"]`);
}

test('the carrier picker scrolls the keyboard highlight into view', async ({ page }) => {
  await openApp(page, { devices: MANY_DEVICES, defaultDeviceId: 'dev-0' });
  const combo = await openCarrierPicker(page);
  const menu = page.getByRole('listbox', { name: 'Playback side' });

  // Nine rows do not fit the menu, and the focus never leaves the trigger — so
  // nothing scrolls after the highlight unless the control does it. The menu's
  // own box is re-read each time: scrolling the page moves the menu with it.
  for (let i = 0; i < 8; i += 1) await page.keyboard.press('ArrowDown');
  const last = await highlighted(page, combo);
  await expect(last).toHaveText('Device 8');
  const lastMenu = await menu.boundingBox();
  const lastBox = await last.boundingBox();
  expect(lastMenu).not.toBeNull();
  expect(lastBox).not.toBeNull();
  expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(lastMenu!.y + lastMenu!.height + 1);

  await page.keyboard.press('Home');
  const first = await highlighted(page, combo);
  await expect(first).toHaveText('Not configured');
  const firstMenu = await menu.boundingBox();
  const firstBox = await first.boundingBox();
  expect(firstBox!.y).toBeGreaterThanOrEqual(firstMenu!.y - 1);
});

test('a device list that shrinks under an open picker leaves a row to choose', async ({
  page,
}) => {
  await openApp(page, { devices: MANY_DEVICES, defaultDeviceId: 'dev-0' });
  const combo = await openCarrierPicker(page);

  await page.keyboard.press('End');
  await setDevices(page, MANY_DEVICES.slice(0, 3));
  await emit(page, 'audio-changed', { devices: true, sessions: false });
  await expect(page.getByRole('option', { name: 'Device 8' })).toHaveCount(0);

  // The highlight follows the list down rather than pointing at a row that is
  // gone, so `Enter` still hands the carrier a device that exists.
  const row = await highlighted(page, combo);
  await expect(row).toHaveText('Device 3');
  await page.keyboard.press('Enter');

  const set = await callsFor(page, 'set_feed_carrier');
  expect(set).toHaveLength(1);
  expect(set[0]?.args).toMatchObject({ render: 'dev-2' });
});
