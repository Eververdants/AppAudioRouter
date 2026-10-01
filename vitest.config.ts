import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Unit / integration tests (Vitest).
 *
 * Deliberately separate from `vite.config.ts`: the app's config carries the
 * production build graph, while these tests need an environment the browser
 * does not provide (jsdom) and must not be part of the bundle's resolution.
 *
 * Nothing here talks to a real backend. The Tauri IPC layer is replaced by
 * `@tauri-apps/api/mocks` (see `src/test/setup.ts` and the individual tests),
 * so a run depends on nothing but this repository.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  define: {
    // `src/lib/productionGuards.ts` and `src/main.tsx` branch on this.
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    // Explicit `import { describe, it, expect } from 'vitest'` everywhere, so
    // no global types leak into `tsc --noEmit` over `src`.
    globals: false,
    restoreMocks: true,
    // A test that leaves a timer or a listener behind must not be able to
    // affect the next one.
    clearMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
