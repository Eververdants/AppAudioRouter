import { expect, test } from '@playwright/test';
import { callsFor } from './fixtures';
import { DEFAULT_STATE, installBridge } from './tauri/bridge';

/**
 * The language every other spec pins away from.
 *
 * `installBridge` writes `aar-language = en` before the app boots, because the
 * suite matches English words and a zh-CN machine would otherwise turn all forty
 * of them red on text none of them is about. That pin also hides the Chinese
 * path entirely — and one of its consequences is not a string but an *argument*:
 * the documentation button hands the Rust allowlist a different key, so a
 * regression there would open the English README on a Chinese screen and no
 * English-speaking spec could ever notice.
 */

test('the screen, the tray menu and the documentation key all follow the chosen language', async ({
  page,
}) => {
  await installBridge(page, DEFAULT_STATE);
  // Init scripts run in the order they were added, all of them before any app
  // code, so this one gets the last word on the key `i18n` reads at boot.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('aar-language', 'zh-CN');
    } catch {
      /* unreadable storage leaves the system language; the box would have to be
         Chinese for that to say anything other than zh-CN */
    }
  });
  await page.goto('/');

  await expect(page.getByRole('heading', { name: '应用程序' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '活动记录' })).toBeVisible();
  // The switch is a switch, not a second copy of the interface.
  await expect(page.getByRole('heading', { name: 'Apps' })).toHaveCount(0);
  // The declared language moves with the rendered one: a screen reader takes its
  // pronunciation engine, and the font fallback its shape, from here.
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('zh-CN');

  // The tray is a native control that cannot read i18next, so its words are
  // pushed over by the frontend — in the language the user is looking at.
  const labeled = await callsFor(page, 'set_tray_labels');
  expect(labeled.length).toBeGreaterThan(0);
  expect(labeled[labeled.length - 1]?.args).toMatchObject({
    openSettings: '打开设置',
    stopAll: '停止全部路由',
    quit: '退出',
    autostartChecked: false,
  });

  // And the one place where the language decides what the backend is told. The
  // frontend names a key and nothing else; the URLs live in `commands.rs`.
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('button', { name: '关于', exact: true }).click();
  await page.getByRole('button', { name: '打开说明文档' }).click();
  const opened = await callsFor(page, 'open_help_page');
  expect(opened).toHaveLength(1);
  expect(opened[0]?.args).toEqual({ key: 'readme-zh' });
});
