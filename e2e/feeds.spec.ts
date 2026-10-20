import { expect, test } from '@playwright/test';
import {
  appRow,
  callsFor,
  changePrimary,
  deviceRowShell,
  feedRow,
  hub,
  openApp,
  railRow,
  resetCalls,
  stopAllRail,
} from './fixtures';

/**
 * Sending one programme's audio into another's input — the "programme to
 * programme" half of 2.3.0.
 *
 * A feed is not a plan edit like a device route is: it pins an endpoint on each
 * end, so it connects the moment it is picked and the toast carries the way
 * back. What these specs hold the UI to is exactly that difference — plus the
 * honest states for the ways a recorded feed can be silent.
 */

/** Add one programme's input as a destination, through the dashed card. */
async function addFeedTarget(page: import('@playwright/test').Page, process: string) {
  await page.locator('main').getByRole('button', { name: 'Add destination' }).click();
  // Scoped to the menu: the change-primary picker can still be mid-exit when
  // this opens, and both lists carry the same programme names.
  await page
    .getByRole('menu', { name: 'Add destination' })
    .getByRole('menuitem', { name: `${process}'s input` })
    .click();
}

test('a programme can be sent into another programmé’s input, and taken back', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();

  await addFeedTarget(page, 'game.exe');

  const feeds = await callsFor(page, 'set_feed_target');
  expect(feeds).toHaveLength(1);
  expect(feeds[0]?.args).toMatchObject({
    sourcePid: 1001,
    sourceExe: 'music.exe',
    targetPid: 1002,
    targetExe: 'game.exe',
  });

  // The board says so without waiting for the hub: a feed connects at once.
  await expect(feedRow(page, 1002)).toBeVisible();
  await expect(feedRow(page, 1002)).toContainText('Send in');
  expect(await callsFor(page, 'apply_route')).toHaveLength(0);

  // And the toast offers the way back, which is the whole of the undo a feed
  // has — there is no hub press to reverse.
  await page.getByRole('button', { name: 'Undo' }).click();
  const removed = await callsFor(page, 'remove_feed_target');
  expect(removed).toHaveLength(1);
  expect(removed[0]?.args).toMatchObject({ sourcePid: 1001, targetPid: 1002 });
  await expect(feedRow(page, 1002)).toHaveCount(0);
});

test('a feed with no carrier configured is recorded and says why it is silent', async ({
  page,
}) => {
  await openApp(page, { feedCarrier: { render: null, capture: null } });
  await appRow(page, 'music.exe').click();

  await addFeedTarget(page, 'game.exe');

  // Recorded: the rule is in the memory and on the board.
  expect(await callsFor(page, 'set_feed_target')).toHaveLength(1);
  await expect(feedRow(page, 1002)).toBeVisible();
  // Honest: the card says the rule has nothing to carry it yet, rather than
  // showing a wire that moves no sound.
  await expect(feedRow(page, 1002)).toContainText('No carrier');
});

test('the wire a sibling process shows is its programme’s own, and its ✕ cuts it', async ({
  page,
}) => {
  await openApp(page, {
    sessions: [
      { pid: 1001, exe_name: 'music.exe' },
      { pid: 1003, exe_name: 'music.exe' },
      { pid: 1002, exe_name: 'game.exe' },
    ],
    feeds: [['music.exe', 'game.exe']],
  });

  // A feed is the program's, addressed at its lowest pid; the board is being
  // looked at through a sibling process of that program. The amber row is the
  // same wire — so its ✕ has to address the wire, not the process on screen,
  // which is the press that used to do nothing at all.
  await railRow(page, 1003).locator('button').first().click();
  await expect(feedRow(page, 1002)).toBeVisible();
  await resetCalls(page);

  await feedRow(page, 1002).getByRole('button').click();

  const removed = await callsFor(page, 'remove_feed_target');
  expect(removed).toHaveLength(1);
  expect(removed[0]?.args).toMatchObject({ sourcePid: 1001, targetPid: 1002 });
  await expect(feedRow(page, 1002)).toHaveCount(0);
});

test('a device route and a feed sit on the same board', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();

  // Naming the TV as main replaces the staged guess, so the plan the hub lands
  // is the device the user named — not that device plus the guess.
  await changePrimary(page, 'Speakers', 'TV');
  await addFeedTarget(page, 'game.exe');
  await hub(page).click();

  const applied = await callsFor(page, 'apply_route');
  expect(applied).toHaveLength(1);
  expect(applied[0]?.args.deviceIds).toEqual(['tv']);
  // The feed was already connected — the hub lands the device plan, and does
  // not touch the feed's own endpoints.
  expect(await callsFor(page, 'set_feed_target')).toHaveLength(1);
  await expect(feedRow(page, 1002)).toBeVisible();
});

test('a feed from a routed programme is held, and carries sound again when the route stops', async ({
  page,
}) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();
  await hub(page).click();

  await addFeedTarget(page, 'game.exe');

  // The rule is recorded all the same, but the program's one render slot already
  // plays a device, so nothing moves into the target's input — and the card says
  // which of the two silences this is rather than drawing a wire that carries none.
  await expect(feedRow(page, 1002)).toContainText('Held');
  expect(await callsFor(page, 'remove_feed_target')).toHaveLength(0);

  await page.getByRole('tab', { name: 'Activity' }).click();
  await expect(
    page.getByText('recorded, held while music.exe is routed to a device'),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Routing' }).click();

  // Freeing the slot re-opens the rule that was never un-made: the device route
  // and the feed are two separate books, and stopping one leaves the other alone.
  // Stopping takes the programme off the stage with it (the selection belongs to
  // the route), so the row is read from the board it lands back on.
  await stopAllRail(page).click();
  await stopAllRail(page).click();
  await appRow(page, 'music.exe').click();
  await expect(feedRow(page, 1002)).toContainText('Send in');
});

/** The carrier's playback side as the machine names it. */
const CARRIER = 'CABLE Input (VB-Audio Virtual Cable)';
/**
 * The carrier is a pipe, not an output.
 *
 * The user named its playback side in settings, so the board must not hand it
 * back as a destination — a programme routed into the pipe is a feed's job, and
 * a feed owns both of its ends. The two lists are where the board offers
 * devices, so both are where the name has to be missing. Each assertion is
 * paired with a real device that is still there: "the carrier is not in this
 * menu" on its own would also hold for a menu that never opened.
 */
test('the board does not offer the carrier as a destination', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();

  await page.locator('main').getByRole('button', { name: 'Add destination' }).click();
  const addMenu = page.getByRole('menu', { name: 'Add destination' });
  await expect(addMenu.getByRole('menuitem', { name: 'TV', exact: true })).toBeVisible();
  await expect(addMenu.getByRole('menuitem', { name: CARRIER })).toHaveCount(0);

  // The change-primary list reads the whole inventory rather than what is left
  // to add, so it has to reach the same answer by its own route.
  await page.keyboard.press('Escape');
  await changePrimary(page, 'Speakers', 'TV');
  await page
    .locator('main')
    .getByRole('button', { name: 'Change the main device, currently TV' })
    .click();
  const changeMenu = page.getByRole('menu', { name: 'Change' });
  await expect(changeMenu.getByRole('menuitem', { name: 'Speakers', exact: true })).toBeVisible();
  await expect(changeMenu.getByRole('menuitem', { name: CARRIER })).toHaveCount(0);
});

/**
 * A plan the carrier already stands on keeps its row — and its way out.
 *
 * The carrier can be on the plan without ever having been handed out: the
 * system default may be the pipe itself. Hiding that row would take away the
 * only gesture that moves the programme off it, so a device already drawn stays
 * drawn, and the change-primary menu still ticks the seat it holds.
 */
test('a plan the carrier already stands on keeps its row and its seat', async ({ page }) => {
  await openApp(page, { defaultDeviceId: 'cable-in' });
  await appRow(page, 'music.exe').click();

  await expect(deviceRowShell(page, CARRIER)).toContainText('Main');

  await page
    .locator('main')
    .getByRole('button', { name: `Change the main device, currently ${CARRIER}` })
    .click();
  const menu = page.getByRole('menu', { name: 'Change' });
  await expect(menu.getByRole('menuitem', { name: CARRIER })).toHaveAttribute(
    'aria-current',
    'true',
  );

  // And out is still walkable.
  await menu.getByRole('menuitem', { name: 'TV', exact: true }).click();
  await expect(
    page.locator('main').getByRole('button', { name: 'Change the main device, currently TV' }),
  ).toBeVisible();
});
