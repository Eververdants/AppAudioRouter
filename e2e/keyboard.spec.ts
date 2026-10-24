import { expect, test } from '@playwright/test';
import { appRow, callsFor, changePrimary, hub, openApp, railRow } from './fixtures';

/**
 * Every entry point reachable without a pointer: one tab stop for the tab row,
 * the arrows that walk the board's picker, the search box's Escape — and a
 * machine that reports `hover: none`, where an affordance the mouse reveals has
 * to be painted from the start. The picker's sections are the fake's own device
 * graph, so the walk is over names a spec can pin.
 *
 * The audio backend behind them is the fake runtime in `e2e/tauri/bridge.ts`.
 */

test.describe('a machine with no hover to ask with', () => {
  // A touch screen reports `hover: none`: nothing arrives by resting the
  // pointer somewhere, so every affordance the mouse reveals has to be there
  // from the start — and nothing invisible may stay in the way.
  test.use({ hasTouch: true });

  test('the row’s way back is ordinary, not something to discover', async ({ page }) => {
    await openApp(page);
    await appRow(page, 'music.exe').click();
    await changePrimary(page, 'Speakers', 'TV');
    await hub(page).click();

    // No pointer has rested anywhere, so this is the touch screen's first look
    // at the row: the ✕ is painted, and it is live. (Opacity, not the box —
    // a zero-opacity element still has a bounding box.)
    const stop = railRow(page, 1001).getByRole('button', {
      name: /^Stop and return to the system default$|^Click again to confirm$/,
    });
    await expect(stop).toHaveCSS('opacity', '1');
    await stop.click();
    // The first press only asks, exactly as it does under a pointer.
    expect(await callsFor(page, 'stop_route')).toHaveLength(0);
    await stop.click();
    expect(await callsFor(page, 'stop_route')).toHaveLength(1);
  });

  test('the batch toggle is visible without a pointer on the row', async ({ page }) => {
    await openApp(page);
    const toggle = railRow(page, 1002).getByRole('button', {
      name: 'Change this app too',
    });
    await expect(toggle).toHaveCSS('opacity', '1');
  });
});

test('the tab row is one tab stop, and the arrows walk it', async ({ page }) => {
  await openApp(page);

  const routing = page.getByRole('tab', { name: 'Routing' });
  const status = page.getByRole('tab', { name: 'Status' });
  // `role=tablist` promises the arrows and one tab stop for the row: the tabs
  // nobody is on are out of the tab order, and the row carries them itself.
  await expect(routing).toHaveAttribute('tabindex', '0');
  await expect(status).toHaveAttribute('tabindex', '-1');

  await routing.focus();
  await page.keyboard.press('ArrowRight');
  await expect(status).toBeFocused();
  // The view under the row is the tab's panel, and it says whose it is.
  await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', /-briefing$/);

  await page.keyboard.press('ArrowLeft');
  await expect(routing).toBeFocused();
});

test('the board’s picker answers the arrow keys', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();
  await page.locator('main').getByRole('button', { name: 'Add destination' }).click();

  // A `role=menu` is walked with the arrows, one stop for the whole list: the
  // walk runs the picker's sections in order — the devices to switch to, the
  // devices to also play through, the programme inputs — and Home/End jump to
  // the ends of the menu rather than out of it.
  const switchRow = page
    .locator('[data-picker-section="switch"]')
    .getByRole('menuitem', { name: 'TV', exact: true });
  const copyRow = page
    .locator('[data-picker-section="copy"]')
    .getByRole('menuitem', { name: 'TV', exact: true });
  const input = page.getByRole('menuitem', { name: "game.exe's input" });

  // Opening walks in. The menu's rows sit after the whole panel in the
  // document, so a keyboard left outside would Tab past every device on the
  // board before reaching one it could choose; Escape hands the caret back to
  // the button the menu came out of.
  await expect(switchRow).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('main').getByRole('button', { name: 'Add destination' })).toBeFocused();
  await page.locator('main').getByRole('button', { name: 'Add destination' }).click();

  await switchRow.focus();
  await page.keyboard.press('ArrowDown');
  await expect(copyRow).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(input).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(copyRow).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(switchRow).toBeFocused();
  await page.keyboard.press('End');
  await expect(input).toBeFocused();
});

test('search narrows the app list', async ({ page }) => {
  await openApp(page);

  await page.getByLabel('Search apps').fill('game');

  await expect(appRow(page, 'game.exe')).toBeVisible();
  await expect(appRow(page, 'music.exe')).toBeHidden();
  await expect(page.getByText('No app matches the search')).toBeHidden();

  // Escape clears the box the way it does everywhere else.
  await page.getByLabel('Search apps').press('Escape');
  await expect(appRow(page, 'music.exe')).toBeVisible();
});
