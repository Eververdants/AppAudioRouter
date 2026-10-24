import { expect, test } from '@playwright/test';
import {
  addDevice,
  appRow,
  callsFor,
  changePrimary,
  hub,
  openApp,
  routedCapsule,
  routedPanel,
  routedRow,
  stopAllRail,
} from './fixtures';

/**
 * The two places a route is managed rather than proposed: the routed capsule —
 * every live route at once, each with a stop that asks first — and the app list
 * header's way back for everything. Neither of them starts a route, so neither
 * has a button that could; both only take one away, and both count what is left.
 *
 * The audio backend behind them is the fake runtime in `e2e/tauri/bridge.ts`.
 */

test('the routed capsule expands to every routed programme and opens its board', async ({
  page,
}) => {
  await openApp(page);

  // Nothing is routed, so there is nothing to manage and no capsule at all.
  await expect(routedCapsule(page)).toHaveCount(0);

  await appRow(page, 'music.exe').click();
  await changePrimary(page, 'Speakers', 'TV');
  await hub(page).click();
  await appRow(page, 'game.exe').click();
  await changePrimary(page, 'Speakers', 'TV');
  await hub(page).click();

  // The capsule counts what is live right now, and expands to one row per
  // routed programme, naming where its sound comes out.
  await expect(routedCapsule(page)).toContainText('2 routed');
  await routedCapsule(page).click();
  await expect(routedPanel(page)).toBeVisible();
  await expect(routedRow(page, 1001)).toContainText('TV');
  await expect(routedRow(page, 1002)).toContainText('TV');

  // A row's name is the door to that programme's own board, where its levers
  // live — the capsule stops routes, it does not tune them.
  await routedRow(page, 1001)
    .getByRole('button', { name: /music.exe/ })
    .click();
  await expect(hub(page)).toContainText('music.exe');
  await expect(routedPanel(page)).toHaveCount(0);
});

test('the routed capsule stops one programme, and asks before it does', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();
  await changePrimary(page, 'Speakers', 'TV');
  await hub(page).click();
  await appRow(page, 'game.exe').click();
  await addDevice(page, 'TV');
  await hub(page).click();

  await routedCapsule(page).click();
  const stop = routedRow(page, 1001).getByRole('button', {
    name: /^Stop and return to the system default$|^Click again to confirm$/,
  });
  await stop.click();
  expect(await callsFor(page, 'stop_route')).toHaveLength(0);
  await stop.click();
  expect(await callsFor(page, 'stop_route')).toHaveLength(1);

  // The row leaves with its route, and the capsule counts what is left.
  await expect(routedRow(page, 1001)).toHaveCount(0);
  await expect(routedCapsule(page)).toContainText('1 routed');
});

test('the rail header offers a way back for everything, and asks once before taking it', async ({
  page,
}) => {
  await openApp(page);

  // Nothing is routed, so there is nothing to take back.
  await expect(stopAllRail(page)).toBeHidden();

  await appRow(page, 'music.exe').click();
  await changePrimary(page, 'Speakers', 'TV');
  await hub(page).click();

  // The way out of every route at once sits in the list header.
  await expect(stopAllRail(page)).toBeVisible();
  await stopAllRail(page).click();
  // First press only asks.
  expect(await callsFor(page, 'stop_route')).toHaveLength(0);

  await stopAllRail(page).click();
  expect(await callsFor(page, 'stop_route')).toHaveLength(1);
  // And with nothing left routed, the offer goes away with it.
  await expect(stopAllRail(page)).toBeHidden();
});
