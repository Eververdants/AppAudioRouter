import { expect, test } from '@playwright/test';
import { appRow, changePrimary, deviceRowShell, hub, openApp } from './fixtures';

/**
 * The board is a fixed 640px canvas beside a 236px rail: 878px of layout, and
 * the window's own minimum has to have room for all of it.
 *
 * The app used to open at 900px — twelve pixels of slack each side — and to
 * allow itself to be dragged down to 720, where the board was clipped by the
 * window edge with no scrollbar able to bring it back (the well had nothing to
 * scroll: it was as wide as its content). These specs hold the two sizes the
 * window can actually take to the board's own arithmetic.
 */

const BOARD_W = 640;
/** The app list, as laid out in App.tsx. */
const RAIL_W = 236;
/** The narrowest the window is allowed to be — `tauri.conf.json`'s minWidth. */
const MIN_WINDOW_W = 900;

test('at the minimum window width the whole board is inside the window', async ({ page }) => {
  await page.setViewportSize({ width: MIN_WINDOW_W, height: 680 });
  await openApp(page);
  await appRow(page, 'music.exe').click();
  await changePrimary(page, 'Speakers', 'TV');

  const railBox = await page.locator('aside').boundingBox();
  // The well is the board's scroll container: it is as wide as the board when
  // the window has room for it, and its own scrollWidth is what says whether
  // anything is hidden past the edge.
  const well = page.locator('main .overflow-x-auto').first();
  const wellBox = await well.boundingBox();
  const wellMetrics = await well.evaluate((el) => ({
    clientWidth: el.clientWidth,
    scrollWidth: el.scrollWidth,
  }));

  expect(railBox?.width).toBe(RAIL_W);
  expect(railBox?.x).toBe(0);
  // Nothing is scrolled away and nothing is cut: the well is at least as wide
  // as the board, and the board fits inside it exactly.
  expect(wellMetrics.clientWidth).toBeGreaterThanOrEqual(BOARD_W);
  expect(wellMetrics.scrollWidth).toBe(wellMetrics.clientWidth);
  expect((wellBox?.x ?? 0) + (wellBox?.width ?? 0)).toBeLessThanOrEqual(MIN_WINDOW_W);
  await expect(deviceRowShell(page, 'TV')).toBeVisible();
});

test('the work area never overflows the window it was given', async ({ page }) => {
  await page.setViewportSize({ width: MIN_WINDOW_W, height: 560 });
  await openApp(page);
  await appRow(page, 'music.exe').click();
  await changePrimary(page, 'Speakers', 'TV');
  await hub(page).click();

  // The root clips anything past its edge, so an overflowing layout is not a
  // scrollbar — it is content nobody can reach. `document.scrollWidth` is how
  // the broken version showed itself: still the window's own width, while the
  // rail sat at a negative x because the browser had scrolled the clip box.
  const geometry = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    railLeft: document.querySelector('aside')?.getBoundingClientRect().left ?? null,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.innerWidth);
  expect(geometry.railLeft).toBe(0);
});
