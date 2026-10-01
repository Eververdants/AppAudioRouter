import { expect, test } from '@playwright/test';
import { appRow, callsFor, deviceNode, emit, hub, openApp, setFailing, setSessions } from './fixtures';

/**
 * The flows a user actually performs, end to end: pick an app, pick a device,
 * confirm at the hub, undo it, search, and let a Core Audio notification change
 * the list. The audio backend behind them is the fake runtime in
 * `e2e/tauri/bridge.ts`, so these run the same on any machine — including CI.
 */

test('shows the apps and the devices the backend reports', async ({ page }) => {
  await openApp(page);

  await expect(appRow(page, 'music.exe')).toBeVisible();
  await expect(appRow(page, 'game.exe')).toBeVisible();
  await expect(deviceNode(page, 'Speakers')).toBeVisible();
  await expect(deviceNode(page, 'TV')).toBeVisible();
  // Nothing is selected yet, so the hub says what to do rather than offering
  // to do something.
  await expect(page.getByText('Select an app, pick a device, confirm at the center')).toBeVisible();
});

test('selecting an app prefills the device it plays through', async ({ page }) => {
  await openApp(page);

  await appRow(page, 'music.exe').click();

  // The system default is what an unrouted app plays through, and it is what
  // the hub offers to change.
  await expect(hub(page)).toContainText('Output to Speakers');
  // The row says the same thing in its own words.
  await expect(appRow(page, 'music.exe')).toContainText('Speakers');
});

test('routes only after the hub is confirmed a second time', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();

  // First press only asks. Nothing has been sent to the backend yet.
  await hub(page).click();
  await expect(page.getByText('Click again to confirm')).toBeVisible();
  expect(await callsFor(page, 'apply_route')).toHaveLength(0);

  // Second press routes.
  await hub(page).click();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();

  const applied = await callsFor(page, 'apply_route');
  expect(applied).toHaveLength(1);
  expect(applied[0]?.args).toMatchObject({ pid: 1001, exeName: 'music.exe', deviceIds: ['speakers'] });
});

test('the first click on another device replaces the prefilled guess', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();

  // The hub prefilled "Speakers" on its own. Choosing the TV must mean "play
  // through the TV instead" — never "play through both".
  await deviceNode(page, 'TV').click();
  await hub(page).click();
  await hub(page).click();

  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
  const applied = await callsFor(page, 'apply_route');
  expect(applied).toHaveLength(1);
  expect(applied[0]?.args.deviceIds).toEqual(['tv']);
});

test('a routed app can be sent back to the system default from the toast', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();
  await hub(page).click();
  await hub(page).click();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();

  await page.getByRole('button', { name: 'Undo' }).click();

  await expect(page.getByRole('button', { name: 'Undo' })).toBeHidden();
  expect(await callsFor(page, 'stop_route')).toHaveLength(1);
});

test('a route the backend rejects leaves the app where it was', async ({ page }) => {
  await openApp(page);
  await setFailing(page, ['apply_route']);

  await appRow(page, 'music.exe').click();
  await hub(page).click();
  await hub(page).click();

  // The attempt was made, nothing was routed, and no undo is offered for a
  // route that never happened.
  expect(await callsFor(page, 'apply_route')).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Undo' })).toBeHidden();
  await expect(appRow(page, 'music.exe')).toBeVisible();
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

test('a backend notification brings a newly playing app onto the list', async ({ page }) => {
  await openApp(page);

  await setSessions(page, [
    { pid: 1001, exe_name: 'music.exe' },
    { pid: 1002, exe_name: 'game.exe' },
    { pid: 1003, exe_name: 'browser.exe' },
  ]);
  await emit(page, 'audio-changed', { devices: false, sessions: true });

  await expect(appRow(page, 'browser.exe')).toBeVisible();
});
