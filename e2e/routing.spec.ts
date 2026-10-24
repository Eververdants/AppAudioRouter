import { expect, test } from '@playwright/test';
import {
  addDevice,
  appRow,
  callsFor,
  changePrimary,
  deviceRow,
  deviceRowShell,
  emit,
  hub,
  openApp,
  setSessions,
} from './fixtures';

/**
 * The plan/fact two-step at the centre of the board: what the app list reports,
 * what picking a programme stages, and what pressing the hub actually asks the
 * backend for. Staging is a question and the route is the answer, so these tests
 * are about when the hub is a button and when it is not — and about the one
 * record a landed route leaves on the screen.
 *
 * The audio backend behind them is the fake runtime in `e2e/tauri/bridge.ts`, so
 * these run the same on any machine — including CI.
 */

test('shows the apps the backend reports, and the devices a plan reaches', async ({ page }) => {
  await openApp(page);

  await expect(appRow(page, 'music.exe')).toBeVisible();
  await expect(appRow(page, 'game.exe')).toBeVisible();
  // Nothing is picked, so there is no hub yet — the board is a guide, not a
  // button waiting to be pressed, and it draws a plan rather than an inventory.
  await expect(hub(page)).toHaveCount(0);
  await expect(deviceRow(page, 'Speakers')).toHaveCount(0);

  // Picking a programme stages the device it already plays through, and *that*
  // is what puts a device card on the board. The staged device sits in the
  // primary row, whose name opens the change-primary picker instead of
  // toggling anything — the row is where the seat is changed, not switched off.
  await appRow(page, 'music.exe').click();
  await expect(deviceRowShell(page, 'Speakers')).toBeVisible();

  // The device the plan does not reach is not a card yet; the dashed card is
  // how it joins.
  await expect(deviceRow(page, 'TV')).toHaveCount(0);
  await expect(page.locator('main').getByRole('button', { name: 'Add destination' })).toBeVisible();
});

test('selecting an app stages the device it plays through, without routing it', async ({
  page,
}) => {
  await openApp(page);

  await appRow(page, 'music.exe').click();

  // The system default is what an unrouted app plays through, and it is what
  // the board stages — the screen opens on the reality, not on a guess.
  await expect(hub(page)).toContainText('music.exe');
  await expect(hub(page)).toHaveAttribute('aria-label', /Speakers/);
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

test('a plan that is where the sound already goes is not a question', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();

  // The staged device is the one the programme already plays through, so the
  // hub is the answer rather than a button: pressing it would move nothing
  // audible and would pin the programme to the endpoint it is on, which is
  // exactly the state the startup notice apologises for. A control the browser
  // reports as disabled is the proof — a press never reaches it.
  await expect(hub(page)).toBeDisabled();
  await expect(page.locator('main').getByText('Click to apply')).toHaveCount(0);
  await hub(page).click({ force: true });
  expect(await callsFor(page, 'apply_route')).toHaveLength(0);
  // The rail has nothing to name yet, because nothing was routed.
  await expect(appRow(page, 'music.exe')).not.toContainText('Speakers');
});

test('pressing the hub routes a real change, and a re-selected app is not asked again', async ({
  page,
}) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();
  // Naming another device as main is the change: the plan now departs from
  // where the sound is going, and the hub is the question again.
  await changePrimary(page, 'Speakers', 'TV');

  await hub(page).click();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();

  const applied = await callsFor(page, 'apply_route');
  expect(applied).toHaveLength(1);
  expect(applied[0]?.args).toMatchObject({
    pid: 1001,
    exeName: 'music.exe',
    deviceIds: ['tv'],
  });

  // What was staged is now playing, so the hub stops being a button — asking
  // would be asking the user to confirm what they can hear.
  await expect(hub(page)).toBeDisabled();

  // Another app stages its own target...
  await appRow(page, 'game.exe').click();
  await expect(hub(page)).toContainText('game.exe');
  // ...and coming back to the routed one does not ask to confirm what the user
  // is already looking at.
  await appRow(page, 'music.exe').click();
  await expect(hub(page)).toBeDisabled();
  // The rail now says where the programme is going, because now there is
  // somewhere to name.
  await expect(appRow(page, 'music.exe')).toContainText('TV');
});

test('the card that carries the route is the one that lights up', async ({ page }) => {
  await openApp(page);

  await appRow(page, 'music.exe').click();
  // "Play through the TV instead" is said through the primary row's picker:
  // a device from outside the plan takes the seat and the staged guess — the
  // app's own guess, nothing the user asked for — leaves the plan with it.
  await changePrimary(page, 'Speakers', 'TV');
  await expect(hub(page)).toHaveAttribute('aria-label', /through TV/);

  await hub(page).click();

  // The route's first device is the one Windows plays itself, and the card
  // names it. The device the route does not reach is not on the board at all —
  // the board draws the plan, not an inventory of hardware.
  await expect(deviceRowShell(page, 'TV')).toContainText('Main');
  await expect(deviceRow(page, 'Speakers')).toHaveCount(0);
});

test('naming another device as main replaces the staged guess', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();

  // The board staged "Speakers" on its own — that is the app's guess about
  // where the programme plays, not something the user asked for. Handing the
  // main seat to the TV must mean "play through the TV instead", never "play
  // through both": a second copy of the audio appearing on a device nobody
  // picked is the one mistake this screen exists to prevent.
  await changePrimary(page, 'Speakers', 'TV');
  await expect(hub(page)).toHaveAttribute('aria-label', /TV/);
  await expect(hub(page)).not.toHaveAttribute('aria-label', /Speakers/);

  await hub(page).click();
  const applied = await callsFor(page, 'apply_route');
  expect(applied).toHaveLength(1);
  expect(applied[0]?.args.deviceIds).toEqual(['tv']);
});

test('picking the same app again throws the picks away and sends nothing', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();

  await addDevice(page, 'TV');
  await expect(hub(page)).toHaveAttribute('aria-label', /TV/);
  // And the add menu only ever appends: the staged guess keeps the seat it
  // was staged in, and the TV joins the plan's tail as a copy. Naming another
  // device as main is the picker the primary row carries, not this one.
  await expect(deviceRowShell(page, 'Speakers')).toContainText('Main');
  await expect(deviceRowShell(page, 'TV')).toContainText('Copy');

  // Re-reading the programme's own route back into the stage is the whole of
  // "undo my picks": selecting a programme prefills the plan from reality, so
  // nothing has been applied and there is nothing to reverse.
  await appRow(page, 'music.exe').click();
  await expect(hub(page)).toHaveAttribute('aria-label', /Speakers/);

  expect(await callsFor(page, 'apply_route')).toHaveLength(0);
});

test('a route may never be left with nowhere to play', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();

  // Only the copies carry a way out. The seat's name opens the change-primary
  // picker instead of toggling the device out — a programme whose sound goes
  // nowhere is not a state this app offers, and there is no way back from it
  // that does not involve the system default anyway.
  const removeButtons = page
    .locator('main [data-device-row]')
    .getByRole('button', { name: /from the plan$/ });
  await expect(removeButtons).toHaveCount(0);
  await expect(hub(page)).toHaveAttribute('aria-label', /through Speakers/);

  // And that zero is a guard rather than an empty selector: the copy added below
  // is found by this very locator, so pressing it is what shows the seat has no
  // such button — the guard lives in `NodeStage`'s `toggleTarget`, and the row
  // going away is the only evidence that the plan still holds one device.
  await addDevice(page, 'TV');
  await expect(removeButtons).toHaveCount(1);
  await removeButtons.click();
  await expect(deviceRowShell(page, 'TV')).toHaveCount(0);
  await expect(deviceRowShell(page, 'Speakers')).toBeVisible();
  await expect(removeButtons).toHaveCount(0);
  await expect(hub(page)).toHaveAttribute('aria-label', /through Speakers/);
  expect(await callsFor(page, 'apply_route')).toHaveLength(0);
});

test('the activity tab shows what the app did, behind an underlined rule', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();
  await changePrimary(page, 'Speakers', 'TV');
  await hub(page).click();

  await page.getByRole('tab', { name: 'Activity' }).click();
  await expect(page.getByText('Routed music.exe to TV')).toBeVisible();

  await page.getByRole('tab', { name: 'Routing' }).click();
  await expect(deviceRowShell(page, 'TV')).toBeVisible();
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
