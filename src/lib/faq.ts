/** The FAQ entries in display order. Shared with the build-time static
 *  fallback in `scripts/site-meta.ts`, so the copy crawlers read without
 *  JavaScript can never drift from the copy the section renders. */
export const FAQ_KEYS = [
  'free',
  'driver',
  'running',
  'reset',
  'missing',
  'bluetooth',
  'platform',
] as const;
