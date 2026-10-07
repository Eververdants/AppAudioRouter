import { expect, test } from '@playwright/test';
import {
  addDevice,
  appRow,
  callsFor,
  deviceRow,
  deviceRowShell,
  emit,
  hub,
  openApp,
  routedCapsule,
  routedPanel,
  routedRow,
  setFailing,
  setSessions,
  stopAllRail,
  tuneButton,
  tunerStrip,
} from './fixtures';

/**
 * The flows a user actually performs, end to end: pick an app, pick where it
 * should play, press the hub to apply, undo it, search, and let a Core Audio
 * notification change the list. The audio backend behind them is the fake
 * runtime in `e2e/tauri/bridge.ts`, so these run the same on any machine —
 * including CI.
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
  // is what puts a device card on the board.
  await appRow(page, 'music.exe').click();
  await expect(deviceRow(page, 'Speakers')).toBeVisible();

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
  // the hub offers to change.
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

test('pressing the hub routes it, and a re-selected app is not asked again', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();

  await hub(page).click();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();

  const applied = await callsFor(page, 'apply_route');
  expect(applied).toHaveLength(1);
  expect(applied[0]?.args).toMatchObject({
    pid: 1001,
    exeName: 'music.exe',
    deviceIds: ['speakers'],
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
  await expect(appRow(page, 'music.exe')).toContainText('Speakers');
});

test('the card that carries the route is the one that lights up', async ({ page }) => {
  await openApp(page);

  await appRow(page, 'music.exe').click();
  await addDevice(page, 'TV');
  await hub(page).click();

  // The route's first device is the one Windows plays itself, and the card
  // names it. The device the route does not reach is not on the board at all —
  // the board draws the plan, not an inventory of hardware.
  await expect(deviceRowShell(page, 'TV')).toContainText('Main');
  await expect(deviceRow(page, 'TV')).toHaveAttribute('aria-pressed', 'true');
  await expect(deviceRow(page, 'Speakers')).toHaveCount(0);
});

test('the first click on another device replaces the staged guess', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();

  // The board staged "Speakers" on its own — that is the app's guess about
  // where the programme plays, not something the user asked for. Choosing the
  // TV must mean "play through the TV instead", never "play through both": a
  // second copy of the audio appearing on a device nobody picked is the one
  // mistake this screen exists to prevent.
  await addDevice(page, 'TV');
  await expect(hub(page)).toHaveAttribute('aria-label', /TV/);
  await expect(hub(page)).not.toHaveAttribute('aria-label', /Speakers/);

  await hub(page).click();
  const applied = await callsFor(page, 'apply_route');
  expect(applied).toHaveLength(1);
  expect(applied[0]?.args.deviceIds).toEqual(['tv']);
});

test('a second device makes a copy, and the copy is the one with its own delay', async ({
  page,
}) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();

  // The first pick replaced the guess; from here on adding another device piles
  // on. Two devices means one of them is a copy this app duplicates to — and a
  // copy is the only thing here a delay can hold back or a gain can attenuate,
  // which is why the controls appear with it and nowhere else.
  await addDevice(page, 'TV');
  await addDevice(page, 'Speakers');

  await expect(deviceRowShell(page, 'Speakers')).toContainText('Copy');
  await expect(deviceRowShell(page, 'TV')).toContainText('Main');

  await hub(page).click();
  expect((await callsFor(page, 'apply_route'))[0]?.args.deviceIds).toEqual(['tv', 'speakers']);

  // The copy's levers live in the strip, behind its number badge; the primary
  // has none of them to offer. Stepping the copy's delay talks to the backend
  // for that device alone.
  await tuneButton(page, 'TV').click();
  await expect(tunerStrip(page).getByText('Primary volume')).toBeVisible();
  await expect(tunerStrip(page).getByText('Delay')).toHaveCount(0);

  await tuneButton(page, 'Speakers').click();
  await tunerStrip(page).getByRole('button', { name: /later/ }).click();
  const delayed = await callsFor(page, 'set_device_delay');
  expect(delayed).toHaveLength(1);
  expect(delayed[0]?.args.deviceId).toBe('speakers');
});

test('the primary tunes the volume of the programme; the copy keeps its own two', async ({
  page,
}) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();

  // One staged device and no engine: neither control has anything it could act
  // on, so the strip's device panel is not reachable at all.
  await expect(tuneButton(page, 'Speakers')).toHaveCount(0);

  // A second device starts an engine: the primary (the TV) carries the
  // programme's session volume, the copy carries its delay and its share —
  // and only the copy has a delay, because nothing of ours sits on the
  // primary's path to hold back.
  await addDevice(page, 'TV');
  await addDevice(page, 'Speakers');

  await tuneButton(page, 'TV').click();
  await expect(tunerStrip(page).getByText('100%')).toBeVisible();
  await expect(tunerStrip(page).getByText('Delay')).toHaveCount(0);

  await tuneButton(page, 'Speakers').click();
  await expect(tunerStrip(page).getByText('100%')).toBeVisible();
  await expect(tunerStrip(page).getByText('Delay')).toBeVisible();
  await expect(tunerStrip(page).getByText('ms')).toBeVisible();

  // Stepping the primary's volume talks to the backend per *programme* —
  // music.exe, not per device — because it is the session volume that moves.
  await tuneButton(page, 'TV').click();
  await tunerStrip(page).getByRole('button', { name: /quieter/ }).click();
  const applied = await callsFor(page, 'set_primary_volume');
  expect(applied).toHaveLength(1);
  expect(applied[0]?.args).toMatchObject({ exeName: 'music.exe', percent: 95 });
  await expect(tunerStrip(page).getByText('95%')).toBeVisible();

  // The floor: 5, because a session volume of 0 is true silence and no gain
  // could give the copies their loudness back.
  const quieter = tunerStrip(page).getByRole('button', { name: /quieter/ });
  for (let step = 0; step < 18; step += 1) {
    await quieter.click();
  }
  await expect(quieter).toBeDisabled();
  // Asserted on the last call rather than on the value's text: the rolling
  // readout keeps its exiting values around, and "95%" contains "5%".
  const walked = await callsFor(page, 'set_primary_volume');
  expect(walked[walked.length - 1]?.args.percent).toBe(5);
});

test('a copy can be promoted to what the system plays directly', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();

  // The first pick replaced the guess with the TV; the second added Speakers
  // as the copy. With no delays set every device ties, so the plan's own order
  // decides who plays directly — the TV, for being there first.
  await addDevice(page, 'TV');
  await addDevice(page, 'Speakers');
  await expect(deviceRowShell(page, 'TV')).toContainText('Main');
  await expect(deviceRowShell(page, 'Speakers')).toContainText('Copy');

  // The copy's own role word is the switch: one press trades the seats in the
  // plan, the role words cross-fade on the spot, and the hub is what moves the
  // hardware.
  await deviceRowShell(page, 'Speakers').getByRole('button', { name: 'Make primary' }).click();
  await expect(deviceRowShell(page, 'Speakers')).toContainText('Main');
  await expect(deviceRowShell(page, 'TV')).toContainText('Copy');
  await expect(hub(page)).toHaveAttribute('aria-label', /Speakers \+ TV/);
  expect(await callsFor(page, 'apply_route')).toHaveLength(0);

  await hub(page).click();
  expect((await callsFor(page, 'apply_route'))[0]?.args.deviceIds).toEqual(['speakers', 'tv']);
});

test('the board draws the primary the delay order will produce', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();
  await addDevice(page, 'TV');
  await addDevice(page, 'Speakers');
  await expect(deviceRowShell(page, 'TV')).toContainText('Main');

  // Stepping the copy earlier than the primary takes the primary's seat on the
  // spot, before the hub is pressed: the route goes out in delay order, so the
  // board would be lying if it kept the word on whoever was picked first. The
  // strip moves with the role — the device the system plays directly has no
  // copy's controls to offer.
  await tuneButton(page, 'Speakers').click();
  await tunerStrip(page).getByRole('button', { name: '10 ms earlier' }).click();
  await expect(deviceRowShell(page, 'Speakers')).toContainText('Main');
  await expect(deviceRowShell(page, 'TV')).toContainText('Copy');
});

test('picking the same app again throws the picks away and sends nothing', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();

  await addDevice(page, 'TV');
  await expect(hub(page)).toHaveAttribute('aria-label', /TV/);

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

  // The only device in the plan cannot be switched off: a programme whose sound
  // goes nowhere is not a state this app offers, and there is no way back from
  // it that does not involve the system default anyway.
  await deviceRow(page, 'Speakers').click();
  await expect(deviceRow(page, 'Speakers')).toHaveAttribute('aria-pressed', 'true');
});

test('a routed app can be sent back to the system default from the toast', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();
  await hub(page).click();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();

  await page.getByRole('button', { name: 'Undo' }).click();

  await expect(page.getByRole('button', { name: 'Undo' })).toBeHidden();
  expect(await callsFor(page, 'stop_route')).toHaveLength(1);
});

test('the routed capsule expands to every routed programme and opens its board', async ({
  page,
}) => {
  await openApp(page);

  // Nothing is routed, so there is nothing to manage and no capsule at all.
  await expect(routedCapsule(page)).toHaveCount(0);

  await appRow(page, 'music.exe').click();
  await hub(page).click();
  await appRow(page, 'game.exe').click();
  await addDevice(page, 'TV');
  await hub(page).click();

  // The capsule counts what is live right now, and expands to one row per
  // routed programme, naming where its sound comes out.
  await expect(routedCapsule(page)).toContainText('2 routed');
  await routedCapsule(page).click();
  await expect(routedPanel(page)).toBeVisible();
  await expect(routedRow(page, 1001)).toContainText('Speakers');
  await expect(routedRow(page, 1002)).toContainText('TV');

  // A row's name is the door to that programme's own board, where its levers
  // live — the capsule stops routes, it does not tune them.
  await routedRow(page, 1001).getByRole('button', { name: /music.exe/ }).click();
  await expect(hub(page)).toContainText('music.exe');
  await expect(routedPanel(page)).toHaveCount(0);
});

test('the routed capsule stops one programme, and asks before it does', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();
  await hub(page).click();
  await appRow(page, 'game.exe').click();
  await addDevice(page, 'TV');
  await hub(page).click();

  await routedCapsule(page).click();
  const stop = routedRow(page, 1001).getByRole('button', {
    name: /^Stop output and return to the system default$|^Click again to confirm$/,
  });
  await stop.click();
  expect(await callsFor(page, 'stop_route')).toHaveLength(0);
  await stop.click();
  expect(await callsFor(page, 'stop_route')).toHaveLength(1);

  // The row leaves with its route, and the capsule counts what is left.
  await expect(routedRow(page, 1001)).toHaveCount(0);
  await expect(routedCapsule(page)).toContainText('1 routed');
});

test('a route the backend rejects leaves the app where it was', async ({ page }) => {
  await openApp(page);
  await setFailing(page, ['apply_route']);

  await appRow(page, 'music.exe').click();
  await hub(page).click();

  // The attempt was made, nothing was routed, and no undo is offered for a
  // route that never happened. The proposal stands, because it is still
  // unanswered.
  expect(await callsFor(page, 'apply_route')).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Undo' })).toBeHidden();
  await expect(hub(page)).toBeEnabled();
  await expect(appRow(page, 'music.exe')).toBeVisible();
});

test('the rail header offers a way back for everything, and asks once before taking it', async ({
  page,
}) => {
  await openApp(page);

  // Nothing is routed, so there is nothing to take back.
  await expect(stopAllRail(page)).toBeHidden();

  await appRow(page, 'music.exe').click();
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

test('the activity tab shows what the app did, behind an underlined rule', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();
  await hub(page).click();

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
  await hub(page).click();

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
  await hub(page).click();
  await emit(page, 'session-activity', { pid: 1001, active: true });
  await expect(page.locator('main [data-wire="1001:speakers"]')).toHaveAttribute(
    'data-live',
    'true',
  );

  await emit(page, 'session-activity', { pid: 1001, active: false });
  await addDevice(page, 'TV');
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
  await hub(page).click();
  await appRow(page, 'game.exe').click();
  await addDevice(page, 'TV');
  await hub(page).click();

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
  await hub(page).click();
  await appRow(page, 'game.exe').click();

  // The game was routed last, so it is the one at the centre.
  await expect(hub(page)).toContainText('game.exe');

  await appRow(page, 'music.exe').click();
  await expect(hub(page)).toContainText('music.exe');
});

test('the briefing button says where things stand, in so many words', async ({ page }) => {
  await openApp(page);

  // Nothing is routed: the plain truth is that everything follows the default.
  const briefing = page.getByRole('button', { name: /no beating around the bush/ });
  await briefing.click();
  await expect(page.getByText('Nothing is redirected')).toBeVisible();

  // Escape takes the bubble down...
  await page.keyboard.press('Escape');
  await expect(page.getByText('Nothing is redirected')).toBeHidden();

  // ...and a route changes the answer: one line per programme, naming devices.
  await appRow(page, 'music.exe').click();
  await hub(page).click();
  await briefing.click();
  await expect(page.getByText(/plays from Speakers now/)).toBeVisible();

  // A press somewhere else closes it too — and the route behind it still lands.
  await deviceRow(page, 'Speakers').click();
  await expect(page.getByText(/plays from Speakers now/)).toBeHidden();

  // The Escape that closed the bubble was unregistered with it, so the search
  // box still owns its own.
  await page.getByLabel('Search apps').fill('music');
  await page.getByLabel('Search apps').press('Escape');
  await expect(appRow(page, 'game.exe')).toBeVisible();
});
