import { expect, test } from '@playwright/test';
import { appRow, callsFor, changePrimary, hub, openApp } from './fixtures';

/**
 * The route record, end to end: what "auto-remember" writes when a landing
 * takes, where the app shows what it wrote, and the way back out of one entry.
 *
 * The backend side is the fake in `e2e/tauri/` — `apply_route` writes the
 * remembered book the way `commands/routes.rs` does (one entry per executable,
 * written only after the landing has taken), so this walks the same wire the
 * product uses. The restore half — what a *later boot* does with the book — is
 * decided by the store and covered by its own suite; here the record is the
 * thing under test.
 */

/** Turn auto-remember on in the routing section, then go back to the board. */
async function turnAutoRememberOn(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Routing' }).click();
  await page.getByRole('switch', { name: 'Auto-remember' }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
}

async function openRememberedSection(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Routing' }).click();
}

test('a landing with auto-remember on writes the record, and the record can be cleared', async ({
  page,
}) => {
  await openApp(page);
  await turnAutoRememberOn(page);

  // Nothing has been landed yet, so there is no record to show.
  await openRememberedSection(page);
  await expect(
    page.getByRole('button', { name: 'Clear the route remembered for music.exe' }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Back', exact: true }).click();

  // Land a route: the record is written by the landing, naming the executable
  // and the devices it went to.
  await appRow(page, 'music.exe').click();
  await changePrimary(page, 'Speakers', 'TV');
  await hub(page).click();

  await openRememberedSection(page);
  const forget = page.getByRole('button', { name: 'Clear the route remembered for music.exe' });
  await expect(forget).toBeVisible();
  // The chip says what was remembered, in the order it will come back in; the
  // sentence lives on the chip, the ✕ inside it only carries the forget label.
  const chip = page.locator('span', { has: forget });
  await expect(chip).toHaveAttribute('title', 'music.exe → TV');

  // The way out of one entry asks nobody: it clears the record then and there.
  await forget.click();
  await expect(forget).toHaveCount(0);
  expect(await callsFor(page, 'clear_route')).toHaveLength(1);
});

test('a landing with auto-remember off writes no record', async ({ page }) => {
  await openApp(page);

  await appRow(page, 'music.exe').click();
  await changePrimary(page, 'Speakers', 'TV');
  await hub(page).click();

  await openRememberedSection(page);
  await expect(
    page.getByRole('button', { name: 'Clear the route remembered for music.exe' }),
  ).toHaveCount(0);
  expect(await callsFor(page, 'clear_route')).toHaveLength(0);
});
