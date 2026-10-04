import { expect, test } from '@playwright/test';
import {
  appRow,
  backToDefault,
  callsFor,
  deviceRow,
  deviceRowShell,
  emit,
  hub,
  openApp,
  routeCancelButton,
  routeConfirmButton,
  routeQuestion,
  setFailing,
  setSessions,
} from './fixtures';

/**
 * The flows a user actually performs, end to end: pick an app, pick where it
 * should play, apply, undo it, search, and let a Core Audio notification change
 * the list. The audio backend behind them is the fake runtime in
 * `e2e/tauri/bridge.ts`, so these run the same on any machine — including CI.
 */

test('shows the apps and the devices the backend reports', async ({ page }) => {
  await openApp(page);

  await expect(appRow(page, 'music.exe')).toBeVisible();
  await expect(appRow(page, 'game.exe')).toBeVisible();
  await expect(deviceRow(page, 'Speakers')).toBeVisible();
  await expect(deviceRow(page, 'TV')).toBeVisible();
  // Nothing is picked, so the bar has nothing to propose and nothing to do.
  await expect(routeQuestion(page)).toContainText('Pick where this app should play');
  await expect(routeConfirmButton(page)).toBeDisabled();
});

test('selecting an app stages the device it plays through, without routing it', async ({ page }) => {
  await openApp(page);

  await appRow(page, 'music.exe').click();

  // The system default is what an unrouted app plays through, and it is what
  // the bar offers to change.
  await expect(routeQuestion(page)).toContainText('music.exe');
  await expect(routeQuestion(page)).toContainText('Speakers');
  await expect(hub(page)).toContainText('music.exe');
  // The app list stays quiet about it: every unrouted programme plays through
  // the same system default, so replaying that down the list would be a column
  // of identical text. Where a programme is going is that row's business —
  // until a route actually exists, and then the row says so.
  await expect(appRow(page, 'music.exe')).not.toContainText('Speakers');
  // The disc it will play through is lit, and only one of them is — the ring
  // names the first device "Main" and every device after it "Copy".
  await expect(page.locator('main').getByText('Main', { exact: true })).toHaveCount(1);

  // Staging is a question, not an action.
  expect(await callsFor(page, 'apply_route')).toHaveLength(0);
});

test('applying routes it, and a re-selected app is not asked again', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();

  await routeConfirmButton(page).click();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();

  const applied = await callsFor(page, 'apply_route');
  expect(applied).toHaveLength(1);
  expect(applied[0]?.args).toMatchObject({
    pid: 1001,
    exeName: 'music.exe',
    deviceIds: ['speakers'],
  });

  // What was staged is now playing, so the bar says so instead of proposing it
  // again — asking would be asking the user to confirm what they can hear.
  await expect(routeQuestion(page)).toContainText('Already playing through Speakers');

  // Another app stages its own target...
  await appRow(page, 'game.exe').click();
  await expect(routeQuestion(page)).toContainText('game.exe');
  // ...and coming back to the routed one does not ask to confirm what the user
  // is already looking at.
  await appRow(page, 'music.exe').click();
  await expect(routeQuestion(page)).toContainText('Already playing through Speakers');
  // The rail now says where the programme is going, because now there is
  // somewhere to name.
  await expect(appRow(page, 'music.exe')).toContainText('Speakers');
});

test('the disc that carries the route is the one that lights up', async ({ page }) => {
  await openApp(page);

  await appRow(page, 'music.exe').click();
  await deviceRow(page, 'TV').click();
  await routeConfirmButton(page).click();

  // The route's first device is the one Windows plays itself, and the ring
  // names it. The device the route does not use is not a copy of anything.
  await expect(deviceRowShell(page, 'TV')).toContainText('Main');
  await expect(deviceRow(page, 'TV')).toHaveAttribute('aria-pressed', 'true');
  await expect(deviceRow(page, 'Speakers')).toHaveAttribute('aria-pressed', 'false');
});

test('the first click on another device replaces the staged guess', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();

  // The bar staged "Speakers" on its own — that is the app's guess about where
  // the programme plays, not something the user asked for. Choosing the TV must
  // mean "play through the TV instead", never "play through both": a second
  // copy of the audio appearing on a device nobody picked is the one mistake
  // this screen exists to prevent.
  await deviceRow(page, 'TV').click();
  await expect(routeQuestion(page)).toContainText('TV');
  await expect(routeQuestion(page)).not.toContainText('Speakers');

  await routeConfirmButton(page).click();
  const applied = await callsFor(page, 'apply_route');
  expect(applied).toHaveLength(1);
  expect(applied[0]?.args.deviceIds).toEqual(['tv']);
});

test('a second device makes a copy, and the copy carries its own delay and level', async ({
  page,
}) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();

  // The first click replaced the guess; from here on a click adds. Two devices
  // means one of them is a copy this app duplicates to — and a copy is the only
  // thing here a delay can hold back or a gain can attenuate, which is why the
  // controls appear with it and nowhere else.
  await deviceRow(page, 'TV').click();
  await deviceRow(page, 'Speakers').click();

  await expect(deviceRowShell(page, 'Speakers')).toContainText('Copy');
  await expect(deviceRowShell(page, 'TV')).toContainText('Main');

  await routeConfirmButton(page).click();
  expect((await callsFor(page, 'apply_route'))[0]?.args.deviceIds).toEqual(['tv', 'speakers']);

  // Stepping the copy's delay talks to the backend for that device alone.
  await page.locator('main').getByRole('button', { name: /later/ }).first().click();
  const delayed = await callsFor(page, 'set_device_delay');
  expect(delayed).toHaveLength(1);
  expect(delayed[0]?.args.deviceId).toBe('speakers');
});

test('revert throws the picks away and sends nothing', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();

  await deviceRow(page, 'TV').click();
  await expect(routeQuestion(page)).toContainText('TV');

  // Re-reading the programme's own route back into the stage is the whole of
  // "undo my picks": nothing has been applied, so there is nothing to reverse.
  await routeCancelButton(page).click();
  await expect(routeQuestion(page)).toContainText('Speakers');

  expect(await callsFor(page, 'apply_route')).toHaveLength(0);
});

test('a route may never be left with nowhere to play', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();

  // The only device in the plan cannot be switched off: a programme whose sound
  // goes nowhere is not a state this app offers, and there is no way back from
  // it that does not involve the system default anyway.
  await deviceRow(page, 'Speakers').click();
  await expect(deviceRow(page, 'Speakers')).toHaveAttribute('aria-pressed', 'true');
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
  // route that never happened. The proposal stands, because it is still
  // unanswered.
  expect(await callsFor(page, 'apply_route')).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Undo' })).toBeHidden();
  await expect(routeConfirmButton(page)).toBeEnabled();
  await expect(appRow(page, 'music.exe')).toBeVisible();
});

test('the bar offers a way back, and asks once before taking it', async ({ page }) => {
  await openApp(page);

  // Nothing is routed, so there is nothing to take back.
  await expect(backToDefault(page)).toBeHidden();

  await appRow(page, 'music.exe').click();
  await routeConfirmButton(page).click();

  // A routed selection puts the way out next to the ring it concerns.
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

test('a spoke flows only while its programme is sounding', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();
  await routeConfirmButton(page).click();

  // Nothing said music.exe was rendering audio, so its spoke is a steady line.
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

test('a plan that is not the route has nothing flowing through it', async ({ page }) => {
  await openApp(page);

  // A route already on the stage is playing; the plan that would replace it is
  // not, so its spoke stays steady even while the programme sounds.
  await appRow(page, 'music.exe').click();
  await routeConfirmButton(page).click();
  await emit(page, 'session-activity', { pid: 1001, active: true });
  await expect(page.locator('main [data-wire="1001:speakers"]')).toHaveAttribute(
    'data-live',
    'true',
  );

  await emit(page, 'session-activity', { pid: 1001, active: false });
  await deviceRow(page, 'TV').click();
  // Counted rather than checked for visibility: with two devices the spoke to
  // the lower one is exactly vertical, and a vertical line has no width to be
  // seen by.
  await expect(page.locator('main [data-wire="1001:tv"]')).toHaveCount(1);
  await expect(page.locator('main [data-wire="1001:tv"]')).not.toHaveAttribute('data-live');
});

test('the rail says where every routed programme plays; the stage draws the one being changed', async ({
  page,
}) => {
  await openApp(page);

  await appRow(page, 'music.exe').click();
  await routeConfirmButton(page).click();
  await appRow(page, 'game.exe').click();
  await deviceRow(page, 'TV').click();
  await routeConfirmButton(page).click();

  // Both programmes are named where they play in the list — that is the answer
  // to "where is sound going" for everything at once — while the ring is the
  // one being worked on, so it draws a single fan.
  await expect(appRow(page, 'music.exe')).toContainText('Speakers');
  await expect(appRow(page, 'game.exe')).toContainText('TV');
  await expect(page.locator('main [data-wire]')).toHaveCount(1);
  await expect(page.locator('main [data-wire="1002:tv"]')).toHaveCount(1);
});

test('the hub follows the programme the rail picks', async ({ page }) => {
  await openApp(page);

  await appRow(page, 'music.exe').click();
  await routeConfirmButton(page).click();
  await appRow(page, 'game.exe').click();

  // The game was routed last, so it is the one at the centre.
  await expect(hub(page)).toContainText('game.exe');

  await appRow(page, 'music.exe').click();
  await expect(hub(page)).toContainText('music.exe');
});
