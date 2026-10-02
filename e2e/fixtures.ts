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
 * The name cell of one device row in the output table.
 *
 * Scoped to `main` and to buttons: the app list lives in `aside`, and the only
 * clickable thing in a device row is its name — the delay and volume cells are
 * separate controls beside it, not inside it.
 */
export function deviceRow(page: Page, name: string) {
  return page.locator('main button').filter({ hasText: name });
}

/**
 * One whole device row of the output table, name and role together.
 *
 * `deviceRow` is the button, which is what a click needs; the role the route
 * gave the device is a sibling of that button, so anything asserting on it has
 * to read the row around both. Matched by the row's own hook rather than by a
 * Tailwind class, which is not a name anything should depend on.
 */
export function deviceRowShell(page: Page, name: string) {
  return page.locator('main [data-device-row]').filter({ hasText: name });
}

/** One row of the app list. */
export function appRow(page: Page, exeName: string) {
  return page.locator('aside button').filter({ hasText: exeName });
}

/**
 * One source node on the routing board, matched by its own hook rather than a
 * Tailwind class. The locator is the node's button — the thing a click selects
 * the program with and the thing that carries `aria-pressed` — so it reads and
 * drives both.
 */
export function sourceNode(page: Page, exeName: string) {
  return page.locator('main [data-source-node]').filter({ hasText: exeName }).locator('button');
}

/**
 * The floating capsule that asks whether to route.
 *
 * Matched by role and accessible name rather than by its text: the app list,
 * the route tree and the capsule all name the same program and device, so a
 * text match would be all three at once.
 */
export function routeQuestion(page: Page) {
  return page.getByRole('group', { name: 'Current route' });
}

/** The capsule's two answers. */
export function routeConfirmButton(page: Page) {
  return page.getByRole('button', { name: 'Route it' });
}

export function routeCancelButton(page: Page) {
  return page.getByRole('button', { name: 'Cancel' });
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
