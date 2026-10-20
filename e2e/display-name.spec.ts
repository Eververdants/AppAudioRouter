import { expect, test } from '@playwright/test';
import { appRow, callsFor, emit, hub, openApp, setSessions } from './fixtures';

/**
 * The display layer a person reads: the window's name leads, the executable
 * stays on the record line, and a window that retitles itself swaps its name
 * without pretending the process list changed.
 */
test.describe('display names', () => {
  test('the rail and the hub lead with the window name', async ({ page }) => {
    await openApp(page, {
      sessions: [
        { pid: 1001, exe_name: 'music.exe', display_name: 'Music Player', playing: true },
        { pid: 1002, exe_name: 'game.exe' },
      ],
    });

    // The row says what the window says — and keeps the exe, which is what
    // this app remembers and routes by, on the line under it.
    const row = appRow(page, 'music.exe');
    await expect(row).toBeVisible();
    await expect(row).toContainText('Music Player');
    await expect(row).toContainText('music.exe');

    await appRow(page, 'music.exe').click();
    await expect(hub(page)).toContainText('Music Player');

    // The name is a display layer only: what the route is written under — and
    // with it the memory, the levels and the endpoint record — is the exe. If a
    // window title ever reached that argument, the route would survive the next
    // tab switch exactly as long as the title did.
    await hub(page).click();
    const applied = await callsFor(page, 'apply_route');
    expect(applied).toHaveLength(1);
    expect(applied[0]?.args).toMatchObject({ pid: 1001, exeName: 'music.exe' });
  });

  test('a program without a display name reads as it always has', async ({ page }) => {
    await openApp(page);

    const row = appRow(page, 'game.exe');
    await expect(row).toContainText('game.exe');
    await expect(row).not.toContainText(' · PID');
    await appRow(page, 'game.exe').click();
    await expect(hub(page)).toContainText('game.exe');
  });

  test('search matches the display name and the exe', async ({ page }) => {
    await openApp(page, {
      sessions: [{ pid: 1001, exe_name: 'music.exe', display_name: 'Music Player' }],
    });

    const search = page.getByRole('textbox', { name: 'Search apps' });
    await search.fill('player');
    await expect(appRow(page, 'music.exe')).toBeVisible();
    await search.fill('music.exe');
    await expect(appRow(page, 'music.exe')).toBeVisible();
    // A name that matches neither means no match, not "nothing is playing".
    await search.fill('nothing-matches-this');
    await expect(page.getByText('No app matches the search')).toBeVisible();
  });

  test('a retitle is a swap on stage, not a list change in the log', async ({ page }) => {
    await openApp(page, {
      sessions: [{ pid: 1001, exe_name: 'music.exe', display_name: 'Music Player' }],
    });
    await appRow(page, 'music.exe').click();

    await setSessions(page, [{ pid: 1001, exe_name: 'music.exe', display_name: 'Now Playing: X' }]);
    await emit(page, 'audio-changed', { devices: false, sessions: true });

    await expect(hub(page)).toContainText('Now Playing:');
    // The hub's name slot is a fixed stage that clips nothing, so a title
    // longer than its budget is capped in data: the visible word truncates
    // where the budget runs out, while the accessible name keeps the whole
    // title. The retitle is still a swap on stage — both layers moved.
    await expect(hub(page)).toHaveAttribute('aria-label', /Now Playing: X/);
    // The refresh behind the notification only logs when the list — pid and
    // exe, deliberately not the display name — actually differs.
    await page.getByRole('tab', { name: 'Activity' }).click();
    await expect(page.getByText('Session list changed')).toHaveCount(0);
  });
});
