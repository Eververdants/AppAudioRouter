import type { Page } from '@playwright/test';
import { registerCalibrationCommands } from './calibration';
import { bridgeConstants } from './constants';
import { registerDiscoveryCommands } from './discovery';
import { registerFeedCommands } from './feeds';
import { registerMemoryCommands } from './memory';
import { registerReleaseCommands } from './release';
import { registerRouteCommands } from './routes';
import { bridgeCore } from './runtime';
import { registerShellCommands } from './shell';
import { registerTuningCommands } from './tuning';
import type { BridgeState } from './types';

/**
 * A fake Tauri runtime for the end-to-end tests.
 *
 * The app is a Tauri window: it talks to Rust through `window.__TAURI_INTERNALS__`
 * and never through HTTP. Rather than start a real backend — which would mean
 * Core Audio, real devices and a Windows-only run — this installs the same
 * surface with a scripted audio graph behind it, before any app code runs.
 *
 * Everything the tests assert on is therefore reproducible: devices, processes,
 * remembered routes and failures are all set by the test, and every command the
 * frontend sends is recorded so a test can check what the UI actually asked for.
 *
 * This file is the door, and the answer to "which file holds the fake's answer to
 * command X": the pieces are split along the seams the real backend uses, one
 * module per domain mirroring `src-tauri/src/commands/` — `discovery`, `routes`,
 * `release`, `feeds`, `memory`, `tuning`, `calibration`, `shell` — over a shared
 * core (`runtime.ts`) that owns the books, the event plumbing and the dispatcher,
 * the scripted graph (`graph.ts`) and the numbers and words copied out of Rust
 * (`constants.ts`). Each of those files except this one runs *inside the page*,
 * serialized by Playwright as its own source text, which is why they share
 * nothing but types and what they hang off `window`.
 */

/** Installs the fake runtime into every page this context opens. */
export async function installBridge(page: Page, state: BridgeState): Promise<void> {
  // The liveness gate reads `document.hasFocus()`, which in a headless browser
  // belongs to whichever parallel worker last held focus — a coin flip unrelated
  // to what a spec asserts. The gate's three conditions stay the app's business;
  // here the focus half is pinned so the flow tests only depend on the events
  // they themselves emit.
  //
  // The language is pinned for the same reason: the app picks it from
  // `navigator.language`, so every string these specs match on would come out in
  // the machine's own language — a zh-CN box would fail the whole suite on text
  // that has nothing to do with what any of them tests.
  await page.addInitScript(() => {
    window.__AAR_WINDOW_FOCUSED__ = true;
    Object.defineProperty(document, 'hasFocus', {
      value: () => window.__AAR_WINDOW_FOCUSED__ !== false,
    });
    try {
      // Key shared with `src/i18n/index.ts`; unreadable storage (the about:blank
      // this also runs on) just falls back to the system language.
      localStorage.setItem('aar-language', 'en');
    } catch {
      /* nothing to do: the specs then read whatever the box speaks */
    }
  });
  // Every script below runs in this order on every navigation, which is the only
  // ordering the page-side pieces have: the mirrored numbers first, then the core
  // that builds the books and the dispatcher, then the domains that register a
  // handler per command into the map the dispatcher reads.
  await page.addInitScript(bridgeConstants);
  await page.addInitScript(bridgeCore, state);
  await page.addInitScript(registerDiscoveryCommands);
  await page.addInitScript(registerRouteCommands);
  await page.addInitScript(registerReleaseCommands);
  await page.addInitScript(registerFeedCommands);
  await page.addInitScript(registerMemoryCommands);
  await page.addInitScript(registerTuningCommands);
  await page.addInitScript(registerCalibrationCommands);
  await page.addInitScript(registerShellCommands);
}

/** The default graph the specs start from — three devices, two apps playing —
 *  re-homed in `./graph.ts` with the rest of the scripted machine, and re-exported
 *  here because it is what every spec's `installBridge` override is measured
 *  against. */
export { DEFAULT_STATE } from './graph';

export type {
  BridgeCalibrationRefusal,
  BridgeCalibrationRun,
  BridgeDevice,
  BridgeHandle,
  BridgeSession,
  BridgeState,
  BridgeToneMarker,
  FailingCommands,
} from './types';
