import { expect, test, type Page } from '@playwright/test';
import { appRow } from './fixtures';
import { DEFAULT_STATE, installBridge } from './tauri/bridge';

/**
 * Low-spec glass is a rendering contract, and rendering contracts are exactly
 * what a computed style can check: with the class on, no pane may compute a
 * `backdrop-filter` (the blur is the cost this mode exists to remove), the
 * specular highlight must stop following the pointer, and the choice must
 * survive a relaunch through the boot script in `index.html`.
 */

const PANE_SELECTOR = '.glass, .glass-strong, .glass-thin';

/** Opens the app with an explicit glass choice written before boot. */
async function openAppWithGlass(page: Page, choice: '0' | '1' | null): Promise<void> {
  if (choice !== null) {
    await page.addInitScript((value) => {
      try {
        localStorage.setItem('aar-glass-lite', value);
      } catch {
        /* ignore */
      }
    }, choice);
  }
  await installBridge(page, DEFAULT_STATE);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Apps' })).toBeVisible();
}

/** The computed `backdrop-filter` of the first glass pane, in document order. */
function backdropOfFirstPane(page: Page) {
  return page.evaluate((selector) => {
    const pane = document.querySelector<HTMLElement>(selector);
    if (!pane) return 'missing';
    return getComputedStyle(pane).backdropFilter || 'none';
  }, PANE_SELECTOR);
}

test('full glass refracts when the user explicitly opts out of low-spec', async ({ page }) => {
  await openAppWithGlass(page, '0');
  await appRow(page, 'music.exe').click();
  const pane = page.locator(PANE_SELECTOR).first();
  await expect(pane).toBeVisible();

  expect(await backdropOfFirstPane(page)).toContain('blur');
});

test('low-spec glass drops the refraction and parks the highlight', async ({ page }) => {
  await openAppWithGlass(page, '1');
  await expect(page.locator('html')).toHaveClass(/glass-lite/);

  // The token itself resolves to none, so every pane inherits it.
  const filter = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--glass-filter').trim(),
  );
  expect(filter).toBe('none');

  await appRow(page, 'music.exe').click();
  const pane = page.locator(PANE_SELECTOR).first();
  await expect(pane).toBeVisible();
  expect(await backdropOfFirstPane(page)).toBe('none');

  // Moving the pointer across the pane must not start the tracking.
  const box = await pane.boundingBox();
  if (!box) throw new Error('glass pane has no bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const gx = await page.evaluate(
    (selector) => document.querySelector<HTMLElement>(selector)?.style.getPropertyValue('--gx') ?? '',
    PANE_SELECTOR,
  );
  expect(gx).toBe('');
});

test('the settings switch writes the choice and a relaunch honours it', async ({ page }) => {
  await openAppWithGlass(page, null);

  // Without a stored choice the machine decides, and this box could be either
  // kind — read the verdict instead of assuming it.
  const initial = await page.evaluate(() =>
    document.documentElement.classList.contains('glass-lite'),
  );

  await page.getByRole('button', { name: 'Settings' }).click();
  const glassSwitch = page.getByRole('switch', { name: 'Reduce glass effects' });
  await expect(glassSwitch).toBeVisible();
  await glassSwitch.click();

  // The switch writes the opposite of whatever the machine had chosen.
  const chosen = !initial;
  if (chosen) {
    await expect(page.locator('html')).toHaveClass(/glass-lite/);
  } else {
    await expect(page.locator('html')).not.toHaveClass(/glass-lite/);
  }
  const stored = await page.evaluate(() => localStorage.getItem('aar-glass-lite'));
  expect(stored).toBe(chosen ? '1' : '0');

  // A relaunch reads the stored choice in the boot script, before first paint.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Apps' })).toBeVisible();
  const after = await page.evaluate(() =>
    document.documentElement.classList.contains('glass-lite'),
  );
  expect(after).toBe(chosen);
});
