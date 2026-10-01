import { expect, type Page } from '@playwright/test';
import { DEFAULT_STATE, installBridge, type BridgeSession, type BridgeState } from './tauri/bridge';

/**
 * The handful of things a spec needs around the app: load it against a scripted
 * backend, wait for the first real frame, then read what the UI asked the
 * backend for or push an event the way Rust would.
 *
 * Everything between those calls is the app doing its own thing — enumerating,
 * rendering, reacting to clicks — with no test-owned state in between.
 */
export async function openApp(page: Page, overrides: Partial<BridgeState> = {}): Promise<void> {
  await installBridge(page, { ...DEFAULT_STATE, ...overrides });
  await page.goto('/');
  // The list is the first thing that carries real data; waiting for it means
  // the boot round-trips have come back and the UI has rendered them.
  await expect(page.getByRole('heading', { name: 'Apps' })).toBeVisible();
  await expect(page.getByText('music.exe').first()).toBeVisible();
}

/** Recorded calls for one command, read out of the page. */
export async function callsFor(page: Page, cmd: string) {
  return page.evaluate((name) => window.__AAR__?.callsFor(name) ?? [], cmd);
}

/** Push a backend event into the running app. */
export async function emit(page: Page, event: string, payload: unknown): Promise<void> {
  await page.evaluate(
    ([name, data]) => window.__AAR__?.emit(name, data),
    [event, payload] as [string, unknown],
  );
}

export async function setSessions(page: Page, sessions: BridgeSession[]): Promise<void> {
  await page.evaluate((next) => window.__AAR__?.setSessions(next), sessions);
}

export async function setFailing(page: Page, commands: string[]): Promise<void> {
  await page.evaluate((next) => window.__AAR__?.setFailing(next), commands);
}

export async function resetCalls(page: Page): Promise<void> {
  await page.evaluate(() => window.__AAR__?.resetCalls());
}

/** Device capsule on the router stage. */
export function deviceNode(page: Page, name: string) {
  return page.locator('main button').filter({ hasText: name });
}

/** One row of the app list. */
export function appRow(page: Page, exeName: string) {
  return page.locator('aside button').filter({ hasText: exeName });
}

/**
 * The hub at the centre of the stage.
 *
 * Matched by its accessible name rather than by any text on the page: the
 * activity strip can be showing a line that contains the word "output", and a
 * loose text match would then be the hub and that strip at once.
 */
export function hub(page: Page) {
  return page.getByRole('button', { name: /Output to|Select an app/ });
}
