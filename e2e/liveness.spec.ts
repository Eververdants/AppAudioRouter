import { expect, test } from '@playwright/test';
import {
  addDevice,
  appRow,
  changePrimary,
  emit,
  hub,
  openApp,
  railRow,
  routedCapsule,
  routedRow,
  setWindowFocused,
} from './fixtures';

/**
 * The two standing loops and the gate that holds them: a line to a device flows
 * while its programme renders audio, the rings pulse for the same fact, and a
 * window nobody is looking at unmounts both rather than pausing them. Nothing
 * here polls — every transition is an event the fake emits the way the backend's
 * notification thread would.
 *
 * The audio backend behind them is the fake runtime in `e2e/tauri/bridge.ts`.
 */

test('a spoke flows only while its programme is sounding', async ({ page }) => {
  await openApp(page);
  await appRow(page, 'music.exe').click();
  await changePrimary(page, 'Speakers', 'TV');
  await hub(page).click();

  // Nothing said music.exe was rendering audio, so its spoke is a steady line.
  const wire = page.locator('main [data-wire="1001:tv"]');
  await expect(wire).toHaveCount(1);
  await expect(wire).not.toHaveAttribute('data-live');
  // The class, not only the attribute: `data-live` is set from the same flag but
  // a spec that reads just it passes with the animation unmounted entirely —
  // which is how a hover-gated flow survived while the dash never ran.

  // The session began to render audio — the same transition the backend's
  // notification thread forwards the moment it happens.
  await emit(page, 'session-activity', { pid: 1001, active: true });
  await expect(wire).toHaveAttribute('data-live', 'true');
  // No pointer is on either card: flowing is the route's own state, not a
  // response to the cursor.
  await expect(wire).toHaveClass(/stage-flow/);

  // The cursor's brightening is a second class of its own, and `.nwire.lit` is
  // what the stylesheet matches — so the token has to arrive separated. A
  // template that loses the space reads `nwire stage-flowlit`: the flow still
  // runs, the hover does nothing, and every other assertion here still passes.
  // The pointer has been sitting on the hub since the click that landed the
  // route, so leave first and make the hover below a real re-entry: a pointer
  // that never moved re-fires no mouseenter, and a hover state lost in between
  // could never come back.
  await page.mouse.move(10, 10);
  await hub(page).hover();
  await expect(wire).toHaveClass(/(?:^|\s)lit(?:\s|$)/);
  await expect(page.locator('main svg path.nwire.lit')).toHaveCount(1);

  // And when it stops, the flow is unmounted rather than left running.
  await emit(page, 'session-activity', { pid: 1001, active: false });
  await expect(wire).not.toHaveAttribute('data-live');
  await expect(wire).not.toHaveClass(/stage-flow/);
});

test('a resting window unmounts the pulsing ring rather than pausing it', async ({ page }) => {
  await openApp(page);

  // A route first, because two of the three places a ring is worn only exist
  // once the programme has one: the capsule counts routed programmes, and the
  // status page lists them.
  await appRow(page, 'music.exe').click();
  await changePrimary(page, 'Speakers', 'TV');
  await hub(page).click();

  // The row's ring is the interface's other standing loop, and it reports the
  // same fact the wire does: this programme is rendering audio right now. The
  // loop is a CSS animation on a `con-ring-live` class, so reading the class is
  // reading the loop — a paused one would leave it on.
  await emit(page, 'session-activity', { pid: 1001, active: true });
  const railRing = railRow(page, 1001).locator('.con-ring');
  const pillRing = routedCapsule(page).locator('.con-ring');
  await expect(railRing).toHaveClass(/con-ring-live/);
  await expect(pillRing).toHaveClass(/con-ring-live/);

  // The capsule's own list row wears one too, on the far side of a click —
  // a mount the board never passes a gate to.
  await routedCapsule(page).click();
  const panelRing = routedRow(page, 1001).locator('.con-ring');
  await expect(panelRing).toHaveClass(/con-ring-live/);
  await expect(page.locator('main [data-wire="1001:tv"]')).toHaveClass(/stage-flow/);

  // The window loses the OS focus, so nobody can see it. Counted across the
  // page rather than row by row: a gate left behind at any one of these mounts
  // would go on repainting a window nobody is looking at.
  await setWindowFocused(page, false);
  await expect(page.locator('.con-ring-live')).toHaveCount(0);
  await expect(page.locator('main .stage-flow')).toHaveCount(0);
  // The rings themselves are still drawn: what left is the loop, not the report.
  await expect(railRing).toHaveCount(1);
  await expect(pillRing).toHaveCount(1);
  await expect(panelRing).toHaveCount(1);

  // And the gate is a gate, not a one-way switch — back in view, back pulsing.
  await setWindowFocused(page, true);
  await expect(railRing).toHaveClass(/con-ring-live/);
  await expect(pillRing).toHaveClass(/con-ring-live/);
  await expect(panelRing).toHaveClass(/con-ring-live/);

  await routedCapsule(page).click();

  // The status page is the third mount, and the one that can be forgotten: it
  // is a separate component, reading the same fact through its own selector.
  await page.getByRole('tab', { name: 'Status' }).click();
  const cardRing = page.locator('[data-briefing-card="music.exe"] .con-ring');
  await expect(cardRing).toHaveClass(/con-ring-live/);
  await setWindowFocused(page, false);
  await expect(page.locator('.con-ring-live')).toHaveCount(0);
  await expect(cardRing).toHaveCount(1);
  await setWindowFocused(page, true);
  await expect(cardRing).toHaveClass(/con-ring-live/);

  // A programme that stops rendering takes the loop with it.
  await emit(page, 'session-activity', { pid: 1001, active: false });
  await expect(railRing).not.toHaveClass(/con-ring-live/);
});

test('a plan that is not the route has nothing flowing through it', async ({ page }) => {
  await openApp(page);

  // A route already on the stage is playing; the plan that would replace it is
  // not, so its spoke stays steady even while the programme sounds.
  await appRow(page, 'music.exe').click();
  await changePrimary(page, 'Speakers', 'TV');
  await hub(page).click();
  await emit(page, 'session-activity', { pid: 1001, active: true });
  await expect(page.locator('main [data-wire="1001:tv"]')).toHaveAttribute('data-live', 'true');

  await emit(page, 'session-activity', { pid: 1001, active: false });
  await addDevice(page, 'Speakers');
  // Counted rather than checked for visibility: with two devices the spoke to
  // the lower one is exactly vertical, and a vertical line has no width to be
  // seen by.
  await expect(page.locator('main [data-wire="1001:tv"]')).toHaveCount(1);
  await expect(page.locator('main [data-wire="1001:tv"]')).not.toHaveAttribute('data-live');
  await expect(page.locator('main [data-wire="1001:speakers"]')).toHaveCount(1);
  await expect(page.locator('main [data-wire="1001:speakers"]')).not.toHaveAttribute('data-live');
});
