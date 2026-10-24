import { expect, test } from '@playwright/test';
import { DEFAULT_STATE, installBridge } from './tauri/bridge';
import {
  addDevice,
  appRow,
  callsFor,
  changePrimary,
  emit,
  hub,
  openApp,
  setFailing,
} from './fixtures';

/**
 * What the app says when the backend refuses. A press that did nothing must not
 * read as a press that worked; a state an engine is in must not expire like a
 * toast; a read that failed is not an empty list. Undo travels with them,
 * because it is the one control offered for a route that does exist.
 *
 * The audio backend behind them is the fake runtime in `e2e/tauri/bridge.ts`,
 * whose injected refusals are what makes each of these reachable at all.
 */

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
  // The reason travels with the sentence, small and second — the backend's own
  // words are evidence for a report, not the first thing to read — and the card
  // says where the whole record lives instead of being the only place it exists.
  await expect(page.getByRole('alert')).toContainText('apply_route failed (injected)');
  await page.getByRole('button', { name: 'See the record' }).click();
  await expect(page.getByRole('tab', { name: 'Activity' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  // Scoped to the record: the card that offered the door is on its way out, and
  // the sentence it carries belongs to the tab now.
  await expect(page.getByRole('tabpanel').getByText('Routing failed')).toBeVisible();
});

test('a failure the user has to act on does not take itself away', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();
  await changePrimary(page, 'Speakers', 'TV');
  // Two devices, because the engine that can die is the one a copy starts.
  await addDevice(page, 'Speakers');
  await hub(page).click();

  // An engine that died is a state, not a moment: a countdown would leave the
  // user with a silent device and no explanation eight seconds later.
  await emit(page, 'duplication-stopped', {
    pid: 1001,
    generation: 1,
    reason: 'error',
    error: 'mirror would not open',
  });
  const card = page.getByRole('alert');
  await expect(card).toContainText('mirror would not open');
  // Still standing long after a transient card would have gone, and dismissable
  // by hand — nothing else is going to take it away.
  await page.waitForTimeout(8500);
  await expect(card).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await expect(card).toHaveCount(0);
});

test('the record wears a dot for the errors nobody has read', async ({ page }) => {
  await openApp(page);
  await setFailing(page, ['apply_route']);
  await appRow(page, 'music.exe').click();
  await changePrimary(page, 'Speakers', 'TV');
  await hub(page).click();

  // The failure was written while the record was closed, so the tab says so.
  await expect(page.getByRole('tab', { name: 'Activity' }).locator('.bg-error')).toHaveCount(1);
  // Opening it reads the line, and the dot goes with it.
  await page.getByRole('tab', { name: 'Activity' }).click();
  await expect(page.getByRole('tab', { name: 'Activity' }).locator('.bg-error')).toHaveCount(0);
});

test('a read that refused is not an empty list', async ({ page }) => {
  // The very first enumeration answers nothing: nobody has asked for a list yet,
  // so nothing on screen is wrong — but "no apps are playing audio" is a claim
  // about the machine, and this moment has simply failed to ask it.
  await installBridge(page, { ...DEFAULT_STATE, failing: ['list_sessions'] });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Apps' })).toBeVisible();

  await expect(page.getByText('Could not read which apps are playing sound')).toBeVisible();
  // The reason travels with it, and so does the one action that answers it.
  await expect(page.getByText('list_sessions failed (injected)')).toBeVisible();

  await setFailing(page, []);
  await page.getByRole('button', { name: 'Retry' }).click();

  // The list the machine actually has arrives, and the complaint goes with it.
  await expect(appRow(page, 'music.exe')).toBeVisible();
  await expect(page.getByText('Could not read which apps are playing sound')).toHaveCount(0);
});
