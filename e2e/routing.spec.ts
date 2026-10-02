import { expect, test } from '@playwright/test';
import {
  appRow,
  backToDefault,
  callsFor,
  deviceRow,
  deviceRowShell,
  emit,
  openApp,
  routeCancelButton,
  routeConfirmButton,
  routeQuestion,
  setFailing,
  setSessions,
  sourceNode,
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
  // The app list stays quiet about it: every unrouted program plays through the
  // same system default, so replaying that down the list would be a column of
  // identical text. Where a program is going is the table's business — until a
  // route actually exists, and then the row says so (see the confirm test).
  await expect(appRow(page, 'music.exe')).not.toContainText('Speakers');
  // The table shows the staged target as staged, not as a fact.
  await expect(page.locator('main').getByText('Pending', { exact: true })).toHaveCount(1);

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
  // The table names the system default as the primary: the system plays this
  // one directly, and its readout agrees about that. The app list now says
  // where the program is going, because now there is somewhere to name.
  await expect(page.locator('main').getByText('Primary', { exact: true })).toHaveCount(1);
  await expect(appRow(page, 'music.exe')).toContainText('Speakers');
});

test('the routed devices sort to the top of the table', async ({ page }) => {
  await openApp(page);

  const yOf = async (name: string) => {
    const box = await deviceRow(page, name).boundingBox();
    return box?.y ?? Number.NaN;
  };

  // Nothing is routed, so the table is in the order the backend reported.
  expect(await yOf('Speakers')).toBeLessThan(await yOf('TV'));

  // Routing to the TV lifts it above the device the route does not use: the
  // leading rows of the table are the route, and the device it replaced is
  // hardware nothing is using. That is what the diagram above the table used to
  // say, drawn a second time and in an order of its own.
  await appRow(page, 'music.exe').click();
  await deviceRow(page, 'TV').click();
  await routeConfirmButton(page).click();

  // The role the route gave it is written beside the device name, a sibling of
  // the name button rather than inside it, so the assertion reads the row.
  await expect(deviceRowShell(page, 'TV')).toContainText('Primary');
  // The rows move on a spring, so this is polled rather than read once.
  await expect(async () => {
    expect(await yOf('TV')).toBeLessThan(await yOf('Speakers'));
  }).toPass();
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

test('a wire flows only while its program is sounding', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();
  await routeConfirmButton(page).click();

  // Nothing said music.exe was rendering audio, so its wire is a steady line.
  const wire = page.locator('main [data-wire="1001:speakers"]');
  await expect(wire).toHaveCount(1);
  await expect(wire).not.toHaveAttribute('data-live');

  // The session began to render audio — the same transition the backend's
  // notification thread forwards the moment it happens.
  await emit(page, 'session-activity', { pid: 1001, active: true });
  await expect(wire).toHaveAttribute('data-live', 'true');

  // And when it stops, the flow is unmounted rather than left running.
  await emit(page, 'session-activity', { pid: 1001, active: false });
  await expect(wire).not.toHaveAttribute('data-live');
});

test('a staged question has nothing flowing through it', async ({ page }) => {
  await openApp(page);

  // A route already on the board is playing; the staged choice that would
  // replace it is not, so its wire stays steady even while the program sounds.
  await appRow(page, 'music.exe').click();
  await routeConfirmButton(page).click();
  await emit(page, 'session-activity', { pid: 1001, active: true });
  await expect(page.locator('main [data-wire="1001:speakers"]')).toHaveAttribute(
    'data-live',
    'true',
  );

  await emit(page, 'session-activity', { pid: 1001, active: false });
  await deviceRow(page, 'TV').click();
  await expect(page.locator('main [data-wire="1001:tv"]')).toBeVisible();
  await expect(page.locator('main [data-wire="1001:tv"]')).not.toHaveAttribute('data-live');
});

test('every routed program is on the board with a wire of its own', async ({ page }) => {
  await openApp(page);

  await appRow(page, 'music.exe').click();
  await routeConfirmButton(page).click();
  await appRow(page, 'game.exe').click();
  await deviceRow(page, 'TV').click();
  await routeConfirmButton(page).click();

  // Both programs are drawn as sources, each with the wire its own route is —
  // the board is where every sound's destination is read at once, not just the
  // newest route's. The keys name the pair a wire joins.
  await expect(sourceNode(page, 'music.exe')).toBeVisible();
  await expect(sourceNode(page, 'game.exe')).toBeVisible();
  await expect(page.locator('main [data-wire="1001:speakers"]')).toHaveCount(1);
  await expect(page.locator('main [data-wire="1002:tv"]')).toHaveCount(1);
  await expect(page.locator('main [data-wire]')).toHaveCount(2);
});

test('clicking a source node makes that program the subject', async ({ page }) => {
  await openApp(page);

  await appRow(page, 'music.exe').click();
  await routeConfirmButton(page).click();
  await appRow(page, 'game.exe').click();
  await deviceRow(page, 'TV').click();
  await routeConfirmButton(page).click();

  // The game was routed last, so it is the subject; the music node is not.
  await expect(sourceNode(page, 'music.exe')).toHaveAttribute('aria-pressed', 'false');

  await sourceNode(page, 'music.exe').click();

  // Selected, exactly as its row in the app list would have done — and since
  // its staged state is its own live route, no question is asked about it.
  await expect(sourceNode(page, 'music.exe')).toHaveAttribute('aria-pressed', 'true');
  await expect(sourceNode(page, 'game.exe')).toHaveAttribute('aria-pressed', 'false');
  await expect(routeQuestion(page)).toBeHidden();
});
