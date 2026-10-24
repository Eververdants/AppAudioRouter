import { expect, test } from '@playwright/test';
import {
  addDevice,
  appRow,
  callsFor,
  changePrimary,
  deviceRowShell,
  hub,
  openApp,
  stripValue,
  tuneButton,
  tunerStrip,
} from './fixtures';

/**
 * The tuning strip under a destination card: which levers a seat and a copy each
 * get, and what moving one says to the backend. The strip's device panel only
 * exists once an engine does, so every test here puts two devices on the plan
 * first — the primary's session volume, the copy's delay and share, and the
 * promotion that swaps their roles without swapping their numbers.
 *
 * The audio backend behind them is the fake runtime in `e2e/tauri/bridge.ts`.
 */

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
  // The figure is the shared scrub control: the arrows step it, and one
  // gesture is one write.
  await stripValue(page, 'delay').focus();
  await page.keyboard.press('ArrowRight');
  await expect(stripValue(page, 'delay')).toHaveAttribute('aria-valuenow', '10');
  // The step run commits once the keys go quiet, so the write is waited for.
  await expect.poll(async () => (await callsFor(page, 'set_device_delay')).length).toBe(1);
  const delayed = await callsFor(page, 'set_device_delay');
  expect(delayed[0]?.args).toMatchObject({ deviceId: 'speakers', delayMs: 10 });
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
  await stripValue(page, 'primary').focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await callsFor(page, 'set_primary_volume')).length).toBe(1);
  const applied = await callsFor(page, 'set_primary_volume');
  expect(applied[0]?.args).toMatchObject({ exeName: 'music.exe', percent: 95 });
  await expect(tunerStrip(page).getByText('95%')).toBeVisible();

  // The floor: 5, because a session volume of 0 is true silence and no gain
  // could give the copies their loudness back. Eighteen more presses reach it,
  // and the slider stops there rather than stepping past.
  await stripValue(page, 'primary').focus();
  for (let step = 0; step < 18; step += 1) {
    await page.keyboard.press('ArrowLeft');
  }
  await expect(stripValue(page, 'primary')).toHaveAttribute('aria-valuenow', '5');
  // One run of steps is one write: the value commits when the keys go quiet, so
  // the call is waited for rather than read the instant the last press lands.
  await expect
    .poll(async () => (await callsFor(page, 'set_primary_volume')).at(-1)?.args.percent)
    .toBe(5);
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

  // The role word is a label, and the action beside it is its own control: a
  // state word that doubles as a button is a press nobody can predict, and on a
  // touch screen — where there is no hover to reveal the offer — it is a press
  // nobody can see coming. The ⇄ carries the accessible name, so the keyboard
  // and a screen reader hear the action, not the state.
  await expect(deviceRowShell(page, 'Speakers').getByText('Copy', { exact: true })).toBeVisible();
  const promote = deviceRowShell(page, 'Speakers').getByRole('button', { name: 'Make primary' });
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
  await stripValue(page, 'delay').focus();
  await page.keyboard.press('ArrowLeft');
  // `aria-valuenow` is the figure as the control reports it: the label on
  // screen uses a typographic minus, and a test that matched that character
  // would be testing the font, not the value.
  await expect(stripValue(page, 'delay')).toHaveAttribute('aria-valuenow', '-10');
  await expect(deviceRowShell(page, 'TV')).toContainText('Main');
  await expect(deviceRowShell(page, 'Speakers')).toContainText('Copy');
});
