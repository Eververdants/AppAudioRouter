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

/**
 * One device disc on the stage.
 *
 * The disc is a circle with a ring drawn inside it and its name written under
 * it, so there is no text to match — it carries the device's name as its
 * accessible name instead, which is what a click needs and what a screen reader
 * reads. Matched by role and name, scoped to `main` because the app list lives
 * in `aside`.
 */
export function deviceRow(page: Page, name: string) {
  return page.locator('main').getByRole('button', { name, exact: true });
}

/**
 * One whole device: the disc, its name and the role word under it.
 *
 * `deviceRow` is the button a click needs; the role word the route gave the
 * device is a sibling of that button, so anything asserting on it has to read
 * the block around both. Matched by the device's own hook.
 */
export function deviceRowShell(page: Page, name: string) {
  return page.locator('main [data-device-row]').filter({ hasText: name });
}

/** One row of the app list. */
export function appRow(page: Page, exeName: string) {
  return page.locator('aside button').filter({ hasText: exeName });
}

/**
 * The hub at the centre of the stage: the programme being routed.
 *
 * One of them, not one per routed programme — the rail is where every
 * programme's destination is read at once, and the stage is where the one you
 * are changing is. Matched by its own hook.
 */
export function hub(page: Page) {
  return page.locator('main [data-source-node]');
}

/**
 * The bar along the bottom that says what will happen and applies it.
 *
 * Matched by role and accessible name rather than by its text: the app list and
 * the bar name the same programme and device, so a text match would be both.
 */
export function routeQuestion(page: Page) {
  return page.getByRole('group', { name: 'Current route' });
}

/** The bar's Apply. */
export function routeConfirmButton(page: Page) {
  return page.getByRole('button', { name: 'Apply' });
}

/** The bar's way of throwing a pick away without applying it. */
export function routeCancelButton(page: Page) {
  return page.getByRole('button', { name: 'Revert' });
}

/**
 * The table header's way back to the system default.
 *
 * A confirm-once button: the first press arms it and changes its accessible
 * name, so the same locator has to match both states.
 */
export function backToDefault(page: Page) {
  return page.getByRole('button', { name: /^Back to system default$|^Click again to confirm$/ });
}
