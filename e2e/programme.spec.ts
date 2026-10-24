import { expect, test } from '@playwright/test';
import {
  addDevice,
  appRow,
  callsFor,
  changePrimary,
  emit,
  hub,
  openApp,
  railRow,
  tuneButton,
  tunerStrip,
} from './fixtures';

/**
 * A programme's own view of itself, as opposed to the one being edited: sibling
 * processes of one executable reporting one fact, one icon ask per executable, a
 * measured delay that only exists with the engine that measured it, and the two
 * readers — the rail and the status page — that answer "where is sound going"
 * for everything at once.
 *
 * The audio backend behind them is the fake runtime in `e2e/tauri/bridge.ts`.
 */

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
