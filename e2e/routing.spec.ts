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
  railRow,
  routedCapsule,
  routedPanel,
  routedRow,
  setFailing,
  setSessions,
  setWindowFocused,
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

test('a second device makes a copy, and the copy is the one with its own delay', async ({
  page,
}) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();

  // Naming the TV as main replaced the guess; from here on adding another
  // device piles on. Two devices means one of them is a copy this app
  // duplicates to — and a copy is the only thing here a delay can hold back or
  // a gain can attenuate, which is why the controls appear with it and nowhere
  // else.
  await changePrimary(page, 'Speakers', 'TV');
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

  // A second device starts an engine: the primary (the TV, named through the
  // primary row's picker) carries the programme's session volume, the copy
  // carries its delay and its share — and only the copy has a delay, because
  // nothing of ours sits on the primary's path to hold back.
  await changePrimary(page, 'Speakers', 'TV');
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
  await tunerStrip(page)
    .getByRole('button', { name: /quieter/ })
    .click();
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

  // The TV took the seat through the primary row's picker, replacing the
  // guess; the second pick added Speakers as the copy. With no delays set
  // every device ties, so the plan's own order decides who plays directly —
  // the TV, for being there first.
  await changePrimary(page, 'Speakers', 'TV');
  await addDevice(page, 'Speakers');
  await expect(deviceRowShell(page, 'TV')).toContainText('Main');
  await expect(deviceRowShell(page, 'Speakers')).toContainText('Copy');

  // The copy's own role word is the switch: one press trades the seats in the
  // plan, the role words cross-fade on the spot, and the hub is what moves the
  // hardware. The offer reaches the keyboard too — a row read by the tab order
  // says what pressing it would do, the same words the pointer gets.
  const promote = deviceRowShell(page, 'Speakers').getByRole('button', { name: 'Make primary' });
  await promote.focus();
  await expect(deviceRowShell(page, 'Speakers').getByText('Make primary')).toBeVisible();
  await expect(deviceRowShell(page, 'Speakers').getByText('Copy', { exact: true })).toBeHidden();
  await promote.click();
  await expect(deviceRowShell(page, 'Speakers')).toContainText('Main');
  await expect(deviceRowShell(page, 'TV')).toContainText('Copy');
  await expect(hub(page)).toHaveAttribute('aria-label', /Speakers \+ TV/);
  expect(await callsFor(page, 'apply_route')).toHaveLength(0);

  await hub(page).click();
  expect((await callsFor(page, 'apply_route'))[0]?.args.deviceIds).toEqual(['speakers', 'tv']);
});

test("stepping a copy's delay never moves the primary seat", async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();
  await changePrimary(page, 'Speakers', 'TV');
  await addDevice(page, 'Speakers');
  await expect(deviceRowShell(page, 'TV')).toContainText('Main');

  // The delay is the copy's compensation, not a vote on the seat: stepping it
  // earlier than the primary holds the sound back, and the seat stays where
  // the user put it. The strip stays on the copy — the role did not change.
  await tuneButton(page, 'Speakers').click();
  await tunerStrip(page).getByRole('button', { name: '10 ms earlier' }).click();
  await expect(deviceRowShell(page, 'TV')).toContainText('Main');
  await expect(deviceRowShell(page, 'Speakers')).toContainText('Copy');
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

test('a routed app can be sent back to the system default from the toast', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();
  await changePrimary(page, 'Speakers', 'TV');
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

test('a route the backend rejects leaves the app where it was', async ({ page }) => {
  await openApp(page);
  await setFailing(page, ['apply_route']);

  await appRow(page, 'music.exe').click();
  await changePrimary(page, 'Speakers', 'TV');
  await hub(page).click();

  // The attempt was made, nothing was routed, and no undo is offered for a
  // route that never happened. The proposal stands, because it is still
  // unanswered.
  expect(await callsFor(page, 'apply_route')).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Undo' })).toBeHidden();
  await expect(hub(page)).toBeEnabled();
  await expect(appRow(page, 'music.exe')).toBeVisible();

  // And the refusal is on the screen, not only in the log: a press that did
  // nothing reads as a press that worked when the sole record sits in a tab
  // nobody opens.
  await expect(page.getByRole('alert')).toContainText('Routing failed');
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
  // device row steps down into the programme inputs and back, and Home/End
  // jump to the ends of the menu rather than out of it.
  const device = page.getByRole('menuitem', { name: 'TV', exact: true });
  const input = page.getByRole('menuitem', { name: "game.exe's input" });

  // Opening walks in. The menu's rows sit after the whole panel in the
  // document, so a keyboard left outside would Tab past every device on the
  // board before reaching one it could choose; Escape hands the caret back to
  // the button the menu came out of.
  await expect(device).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('main').getByRole('button', { name: 'Add destination' })).toBeFocused();
  await page.locator('main').getByRole('button', { name: 'Add destination' }).click();

  await device.focus();
  await page.keyboard.press('ArrowDown');
  await expect(input).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(device).toBeFocused();
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
  await changePrimary(page, 'Speakers', 'TV');
  await hub(page).click();

  // Nothing said music.exe was rendering audio, so its spoke is a steady line.
  const wire = page.locator('main [data-wire="1001:tv"]');
  await expect(wire).toHaveCount(1);
  await expect(wire).not.toHaveAttribute('data-live');
  // The class, not only the attribute: `data-live` is set from the same flag but
  // a spec that reads just it passes with the animation unmounted entirely —
  // which is how a hover-gated flow survived while the dash never ran.

  // The session began to render audio — the same transition the backend's
  // notification thread forwards the moment it happens.
  await emit(page, 'session-activity', { pid: 1001, active: true });
  await expect(wire).toHaveAttribute('data-live', 'true');
  // No pointer is on either card: flowing is the route's own state, not a
  // response to the cursor.
  await expect(wire).toHaveClass(/stage-flow/);

  // The cursor's brightening is a second class of its own, and `.nwire.lit` is
  // what the stylesheet matches — so the token has to arrive separated. A
  // template that loses the space reads `nwire stage-flowlit`: the flow still
  // runs, the hover does nothing, and every other assertion here still passes.
  await hub(page).hover();
  await expect(wire).toHaveClass(/(?:^|\s)lit(?:\s|$)/);
  await expect(page.locator('main svg path.nwire.lit')).toHaveCount(1);

  // And when it stops, the flow is unmounted rather than left running.
  await emit(page, 'session-activity', { pid: 1001, active: false });
  await expect(wire).not.toHaveAttribute('data-live');
  await expect(wire).not.toHaveClass(/stage-flow/);
});

test('a resting window unmounts the pulsing ring rather than pausing it', async ({ page }) => {
  await openApp(page);

  // A route first, because two of the three places a ring is worn only exist
  // once the programme has one: the capsule counts routed programmes, and the
  // status page lists them.
  await appRow(page, 'music.exe').click();
  await changePrimary(page, 'Speakers', 'TV');
  await hub(page).click();

  // The row's ring is the interface's other standing loop, and it reports the
  // same fact the wire does: this programme is rendering audio right now. The
  // loop is a CSS animation on a `con-ring-live` class, so reading the class is
  // reading the loop — a paused one would leave it on.
  await emit(page, 'session-activity', { pid: 1001, active: true });
  const railRing = railRow(page, 1001).locator('.con-ring');
  const pillRing = routedCapsule(page).locator('.con-ring');
  await expect(railRing).toHaveClass(/con-ring-live/);
  await expect(pillRing).toHaveClass(/con-ring-live/);

  // The capsule's own list row wears one too, on the far side of a click —
  // a mount the board never passes a gate to.
  await routedCapsule(page).click();
  const panelRing = routedRow(page, 1001).locator('.con-ring');
  await expect(panelRing).toHaveClass(/con-ring-live/);
  await expect(page.locator('main [data-wire="1001:tv"]')).toHaveClass(/stage-flow/);

  // The window loses the OS focus, so nobody can see it. Counted across the
  // page rather than row by row: a gate left behind at any one of these mounts
  // would go on repainting a window nobody is looking at.
  await setWindowFocused(page, false);
  await expect(page.locator('.con-ring-live')).toHaveCount(0);
  await expect(page.locator('main .stage-flow')).toHaveCount(0);
  // The rings themselves are still drawn: what left is the loop, not the report.
  await expect(railRing).toHaveCount(1);
  await expect(pillRing).toHaveCount(1);
  await expect(panelRing).toHaveCount(1);

  // And the gate is a gate, not a one-way switch — back in view, back pulsing.
  await setWindowFocused(page, true);
  await expect(railRing).toHaveClass(/con-ring-live/);
  await expect(pillRing).toHaveClass(/con-ring-live/);
  await expect(panelRing).toHaveClass(/con-ring-live/);

  await routedCapsule(page).click();

  // The status page is the third mount, and the one that can be forgotten: it
  // is a separate component, reading the same fact through its own selector.
  await page.getByRole('tab', { name: 'Status' }).click();
  const cardRing = page.locator('[data-briefing-card="music.exe"] .con-ring');
  await expect(cardRing).toHaveClass(/con-ring-live/);
  await setWindowFocused(page, false);
  await expect(page.locator('.con-ring-live')).toHaveCount(0);
  await expect(cardRing).toHaveCount(1);
  await setWindowFocused(page, true);
  await expect(cardRing).toHaveClass(/con-ring-live/);

  // A programme that stops rendering takes the loop with it.
  await emit(page, 'session-activity', { pid: 1001, active: false });
  await expect(railRing).not.toHaveClass(/con-ring-live/);
});

test('a programme still sounds when a sibling process makes the sound', async ({ page }) => {
  // Every reader asks per program: the process rendering audio is often not the
  // one the list showed first, and one row saying 未在播放 while the status page
  // pulses the same program reads as the route having failed.
  await openApp(page, {
    sessions: [
      { pid: 1001, exe_name: 'music.exe' },
      { pid: 1003, exe_name: 'music.exe' },
    ],
  });

  await emit(page, 'session-activity', { pid: 1003, active: true });
  await expect(railRow(page, 1003).locator('.con-ring')).toHaveClass(/con-ring-live/);
  await expect(railRow(page, 1001).locator('.con-ring')).toHaveClass(/con-ring-live/);

  // The board's hub reads the same answer for the process it was given.
  await railRow(page, 1001)
    .getByRole('button', { name: /music\.exe/ })
    .click();
  await expect(hub(page).locator('.con-ring')).toHaveClass(/con-ring-live/);
  await expect(hub(page)).toContainText('Playing');
});

test('an executable with two processes is asked for one icon', async ({ page }) => {
  await openApp(page, {
    sessions: [
      { pid: 1001, exe_name: 'music.exe' },
      { pid: 1003, exe_name: 'music.exe' },
    ],
  });

  // Wait for the pixels to land, not for the first ask: the ask is fire-and-forget
  // after the list, and a data URL is final — so once the tile is filled, every
  // ask this pass meant to make has been made.
  await expect(railRow(page, 1001).locator('img')).toBeVisible();
  await expect(railRow(page, 1003).locator('img')).toBeVisible();

  // One ask per executable, from the first session's pid — asking per session is
  // how a sibling dying mid-ask wrote `null` over the good answer for all of them.
  const asked = (await callsFor(page, 'get_process_icon')).map((call) => call.args.pid);
  expect(new Set(asked).size).toBe(1);
  expect(asked[0]).toBe(1001);
});

test('a copy’s measured delay arrives with its engine, not before', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();
  await changePrimary(page, 'Speakers', 'TV');
  await addDevice(page, 'Speakers');
  await hub(page).click();

  await tuneButton(page, 'Speakers').click();
  const delayRow = tunerStrip(page).locator('div[title]').filter({ hasText: 'Delay' });
  // `apply_route` answers before the mirrors are open, so there is nothing to
  // report yet — an invented 0 would read as "this one is already aligned".
  await expect(delayRow).not.toHaveAttribute('title', /Measured/);

  // The engine's fourth event is the only moment its readings exist; nothing
  // else asks again, and nothing here polls.
  await emit(page, 'duplication-ready', { pid: 1001, generation: 1 });
  await expect(delayRow).toHaveAttribute('title', /Measured 20 ms/);

  // The seat is played by Windows itself: there is no stream of ours there to
  // measure, so its strip never carries a reading — not even after the engine
  // reported one for its own devices. Counted first, because "no div carries
  // Measured" is also true of a strip that renders no titled row at all: the
  // primary's one row is the volume, and the delay row it has no place for is
  // what the reading would have sat on.
  await tuneButton(page, 'TV').click();
  await expect(tunerStrip(page).getByText('Primary volume')).toBeVisible();
  const primaryRows = tunerStrip(page).locator('div[title]');
  await expect(primaryRows).toHaveCount(1);
  await expect(primaryRows).not.toHaveAttribute('title', /Measured/);
});

test('a plan that is not the route has nothing flowing through it', async ({ page }) => {
  await openApp(page);

  // A route already on the stage is playing; the plan that would replace it is
  // not, so its spoke stays steady even while the programme sounds.
  await appRow(page, 'music.exe').click();
  await changePrimary(page, 'Speakers', 'TV');
  await hub(page).click();
  await emit(page, 'session-activity', { pid: 1001, active: true });
  await expect(page.locator('main [data-wire="1001:tv"]')).toHaveAttribute('data-live', 'true');

  await emit(page, 'session-activity', { pid: 1001, active: false });
  await addDevice(page, 'Speakers');
  // Counted rather than checked for visibility: with two devices the spoke to
  // the lower one is exactly vertical, and a vertical line has no width to be
  // seen by.
  await expect(page.locator('main [data-wire="1001:tv"]')).toHaveCount(1);
  await expect(page.locator('main [data-wire="1001:tv"]')).not.toHaveAttribute('data-live');
  await expect(page.locator('main [data-wire="1001:speakers"]')).toHaveCount(1);
  await expect(page.locator('main [data-wire="1001:speakers"]')).not.toHaveAttribute('data-live');
});

test('the rail says where every routed programme plays; the stage draws the one being changed', async ({
  page,
}) => {
  await openApp(page);

  await appRow(page, 'music.exe').click();
  await changePrimary(page, 'Speakers', 'TV');
  await hub(page).click();
  await appRow(page, 'game.exe').click();
  await changePrimary(page, 'Speakers', 'TV');
  await hub(page).click();

  // Both programmes are named where they play in the list — that is the answer
  // to "where is sound going" for everything at once — while the ring is the
  // one being worked on, so it draws a single fan.
  await expect(appRow(page, 'music.exe')).toContainText('TV');
  await expect(appRow(page, 'game.exe')).toContainText('TV');
  await expect(page.locator('main [data-wire]')).toHaveCount(1);
  await expect(page.locator('main [data-wire="1002:tv"]')).toHaveCount(1);
});

test('the hub follows the programme the rail picks', async ({ page }) => {
  await openApp(page);

  await appRow(page, 'music.exe').click();
  await changePrimary(page, 'Speakers', 'TV');
  await hub(page).click();
  await appRow(page, 'game.exe').click();

  // The game was routed last, so it is the one at the centre.
  await expect(hub(page)).toContainText('game.exe');

  await appRow(page, 'music.exe').click();
  await expect(hub(page)).toContainText('music.exe');
});

test('the status page shows where everything is going, as a picture', async ({ page }) => {
  await openApp(page);

  // Nothing is routed: the page says so, and names the device everything follows.
  await page.getByRole('tab', { name: 'Status' }).click();
  await expect(page.getByText('Nothing is redirected yet')).toBeVisible();
  await expect(page.getByText('Every sound follows the system default device')).toBeVisible();

  // A route changes the answer: a row per programme, its destinations as chips
  // wearing the role words. Scoped to that programme's card: the rail writes
  // "Speakers" and the board writes "Main" too, and a page-wide `first()`
  // would be satisfied by whichever of those the document happens to hold.
  await page.getByRole('tab', { name: 'Routing' }).click();
  await appRow(page, 'music.exe').click();
  await changePrimary(page, 'Speakers', 'TV');
  await hub(page).click();
  await page.getByRole('tab', { name: 'Status' }).click();
  const card = page.locator('[data-briefing-card="music.exe"]');
  await expect(card.getByText('TV')).toBeVisible();
  await expect(card.getByText('Main', { exact: true })).toBeVisible();

  // The name is a door back to that programme's own board.
  await page.getByRole('button', { name: "Open music.exe's board" }).click();
  await expect(page.getByRole('tab', { name: 'Routing' })).toHaveAttribute('aria-selected', 'true');
});
