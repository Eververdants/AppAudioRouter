/** Central place for the facts the page states about the project.
 *
 *  Every value here is taken from the main repository's README (v2.1.1).
 *  When the app ships a new version, bump `VERSION` and nothing else: the
 *  build injects it into `index.html`, `sitemap.xml`, `llms.txt` and the
 *  web manifest (see `scripts/site-meta.ts`), and every component reads it
 *  from here. `package.json` mirrors it for npm tooling.
 */
export const VERSION = '2.1.1';

export const SITE_NAME = 'App Audio Router';
export const ORG_NAME = 'Eververdants';
export const ORG_URL = 'https://github.com/Eververdants';

// GitHub Pages project site of the main repository. Keep in sync with
// `vite.config.ts` (`base`) only — the canonical links, hreflang alternates,
// `public/robots.txt`, `public/sitemap.xml` and `public/llms.txt` are all
// generated from this value at build time.
export const SITE_URL = 'https://eververdants.github.io/AppAudioRouter/';

/** The languages the page ships in, and where each one is served from.
 *  `path` is relative to `SITE_URL`: the default language keeps the root, the
 *  others get a directory of their own so search engines have a distinct URL
 *  per language to index and to pair with `hreflang`. */
export const SITE_LANGUAGES = [
  { code: 'zh-CN', hreflang: 'zh-CN', ogLocale: 'zh_CN', path: '' },
  { code: 'en', hreflang: 'en', ogLocale: 'en_US', path: 'en/' },
] as const;

/** The language served at `SITE_URL` itself, and the `x-default` target. */
export const DEFAULT_LANGUAGE = 'zh-CN';

export function urlForLanguage(code: string): string {
  const entry = SITE_LANGUAGES.find((language) => language.code === code);
  return new URL(entry?.path ?? '', SITE_URL).href;
}

export const REPO_URL = 'https://github.com/Eververdants/AppAudioRouter';
export const RELEASES_URL = `${REPO_URL}/releases`;
export const ISSUES_URL = `${REPO_URL}/issues`;
export const README_EN_URL = `${REPO_URL}/blob/main/README.md`;
export const README_ZH_URL = `${REPO_URL}/blob/main/README.zh-CN.md`;
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;

/** Relative to `SITE_URL`; also the Open Graph share image. */
export const SCREENSHOT_LIGHT = 'screenshots/app-audio-router-light.png';
export const SCREENSHOT_DARK = 'screenshots/app-audio-router-dark.png';
export const ICON_PATH = 'icon.png';

/** Date of the site's first public deployment (`git log --reverse`). */
export const DATE_PUBLISHED = '2026-09-26';

// TODO(placeholder): additional links (changelog page, demo video, download
// mirror…) have no public URL yet. Add them here when they exist.
