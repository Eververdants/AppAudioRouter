import { expect, test } from '@playwright/test';
import {
  appRow,
  backToDefault,
  callsFor,
  deviceRow,
  emit,
  openApp,
  routeCancelButton,
  routeConfirmButton,
  routeQuestion,
  setFailing,
  setSessions,
} from './fixtures';

/**
 * The flows a user actually performs, end to end: pick an app, pick a device,
 * confirm at the floating capsule, undo it, search, and let a Core Audio
 * notification change the list. The audio backend behind them is the fake
 * runtime in `e2e/tauri/bridge.ts`, so these run the same on any machine —
 * including CI.
 */

test('shows the apps and the devices the backend reports', async ({ page }) => {
  await openApp(page);

  await expect(appRow(page, 'music.exe')).toBeVisible();
  await expect(appRow(page, 'game.exe')).toBeVisible();
  await expect(deviceRow(page, 'Speakers')).toBeVisible();
  await expect(deviceRow(page, 'TV')).toBeVisible();
  // The device table names its columns; with the expert columns switched off
  // (the default) there are two of them, and the delay and volume headings are
  // simply not there.
  await expect(page.locator('main').getByText('Role', { exact: true })).toBeVisible();
  await expect(page.locator('main').getByText('Delay', { exact: true })).toBeHidden();
  // Nothing is selected, so there is nothing to confirm and no question is
  // being asked.
  await expect(routeQuestion(page)).toBeHidden();
  await expect(page.getByText('Select an app, pick a device, then route it')).toBeVisible();
});

test('selecting an app stages the device it plays through, without routing it', async ({ page }) => {
  await openApp(page);

  await appRow(page, 'music.exe').click();

  // The system default is what an unrouted app plays through, and it is what
  // the capsule offers to change.
  await expect(routeQuestion(page)).toContainText('music.exe');
  await expect(routeQuestion(page)).toContainText('Speakers');
  // The row says the same thing in its own words.
  await expect(appRow(page, 'music.exe')).toContainText('Speakers');
  // The table shows the staged target as staged, not as a fact — and so does
  // the tree above it, which is the point: the two surfaces say the same thing.
  await expect(page.locator('main').getByText('Pending', { exact: true })).toHaveCount(2);

  // Staging is a question, not an action.
  expect(await callsFor(page, 'apply_route')).toHaveLength(0);
});

test('confirming the capsule routes it, and a re-selected app is not asked again', async ({
  page,
}) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();

  await routeConfirmButton(page).click();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();

  const applied = await callsFor(page, 'apply_route');
  expect(applied).toHaveLength(1);
  expect(applied[0]?.args).toMatchObject({ pid: 1001, exeName: 'music.exe', deviceIds: ['speakers'] });

  // What was staged is now playing, so the question is answered and the
  // capsule takes itself away.
  await expect(routeQuestion(page)).toBeHidden();

  // Another app stages its own target...
  await appRow(page, 'game.exe').click();
  await expect(routeQuestion(page)).toContainText('game.exe');
  // ...and coming back to the routed one does not ask to confirm what the user
  // is already looking at.
  await appRow(page, 'music.exe').click();
  await expect(routeQuestion(page)).toBeHidden();
  // The tree and the table both name the same device as the primary: the
  // system plays this one directly, and the two readouts agree about it.
  await expect(page.locator('main').getByText('Primary', { exact: true })).toHaveCount(2);
});

test('the first click on another device replaces the staged guess', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();

  // The capsule staged "Speakers" on its own. Choosing the TV must mean "play
  // through the TV instead" — never "play through both".
  await deviceRow(page, 'TV').click();
  await expect(routeQuestion(page)).toContainText('TV');
  await expect(routeQuestion(page)).not.toContainText('Speakers');

  await routeConfirmButton(page).click();
  const applied = await callsFor(page, 'apply_route');
  expect(applied).toHaveLength(1);
  expect(applied[0]?.args.deviceIds).toEqual(['tv']);
});

test('cancelling the capsule drops the staged route and sends nothing', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();
  await expect(routeQuestion(page)).toBeVisible();

  await routeCancelButton(page).click();
  await expect(routeQuestion(page)).toBeHidden();
  await expect(page.locator('main').getByText('Pending', { exact: true })).toBeHidden();

  // Escape is the same answer as the button. Selecting the app again stages the
  // same guess, so the question comes back before it is dismissed.
  await appRow(page, 'music.exe').click();
  await expect(routeQuestion(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(routeQuestion(page)).toBeHidden();

  expect(await callsFor(page, 'apply_route')).toHaveLength(0);
});

test('a routed app can be sent back to the system default from the toast', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();
  await routeConfirmButton(page).click();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();

  await page.getByRole('button', { name: 'Undo' }).click();

  await expect(page.getByRole('button', { name: 'Undo' })).toBeHidden();
  expect(await callsFor(page, 'stop_route')).toHaveLength(1);
});

test('a route the backend rejects leaves the app where it was', async ({ page }) => {
  await openApp(page);
  await setFailing(page, ['apply_route']);

  await appRow(page, 'music.exe').click();
  await routeConfirmButton(page).click();

  // The attempt was made, nothing was routed, and no undo is offered for a
  // route that never happened. The question stays up, because it is still
  // unanswered.
  expect(await callsFor(page, 'apply_route')).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Undo' })).toBeHidden();
  await expect(routeQuestion(page)).toBeVisible();
  await expect(appRow(page, 'music.exe')).toBeVisible();
});

test('the table offers a way back, and asks once before taking it', async ({ page }) => {
  await openApp(page);

  // Nothing is routed, so there is nothing to take back.
  await expect(backToDefault(page)).toBeHidden();

  await appRow(page, 'music.exe').click();
  await routeConfirmButton(page).click();

  // A routed selection puts the way out next to the table it concerns.
  await expect(backToDefault(page)).toBeVisible();
  await backToDefault(page).click();
  // First press only asks.
  expect(await callsFor(page, 'stop_route')).toHaveLength(0);

  await backToDefault(page).click();
  expect(await callsFor(page, 'stop_route')).toHaveLength(1);
  // And with nothing left routed, the offer goes away with it.
  await expect(backToDefault(page)).toBeHidden();
});

test('the activity tab shows what the app did, behind an underlined rule', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();
  await routeConfirmButton(page).click();

  await page.getByRole('tab', { name: 'Activity' }).click();
  await expect(page.getByText('Routed music.exe to Speakers')).toBeVisible();

  await page.getByRole('tab', { name: 'Routing' }).click();
  await expect(deviceRow(page, 'Speakers')).toBeVisible();
});

test('the advanced switch adds the delay and volume columns', async ({ page }) => {
  await openApp(page);
  const columns = page.locator('main');
  await expect(columns.getByText('Volume', { exact: true })).toBeHidden();

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();
  await page.getByRole('switch', { name: 'Advanced controls' }).click();

  // Escape leaves the page the way the back button does.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Apps' })).toBeVisible();

  await expect(columns.getByText('Delay', { exact: true })).toBeVisible();
  await expect(columns.getByText('Volume', { exact: true })).toBeVisible();
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
