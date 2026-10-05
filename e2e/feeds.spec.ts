import { expect, test } from '@playwright/test';
import { addDevice, appRow, callsFor, feedRow, hub, openApp } from './fixtures';

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
  await page.getByRole('menuitem', { name: `${process}'s input` }).click();
}

test('a programme can be sent into another programmé’s input, and taken back', async ({
  page,
}) => {
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

test('a device route and a feed sit on the same board', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();

  await addDevice(page, 'TV');
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
