/** Central place for the facts the page states about the project.
 *
 *  Every value here is taken from the main repository's README (v2.1.0).
 *  When the app ships a new version, bump `VERSION` alongside the README so
 *  the two stay in sync.
 */
export const VERSION = '2.1.0';

// TODO(placeholder): final production URL. This assumes GitHub Pages at the
// default project-site address; if the page is deployed elsewhere (custom
// domain or a root deployment), update it here and in `public/robots.txt`,
// `public/sitemap.xml` and `public/llms.txt` — canonical, og:url and the
// structured data all point at it.
export const SITE_URL = 'https://eververdants.github.io/AppAudioRouter-Website/';

export const REPO_URL = 'https://github.com/Eververdants/AppAudioRouter';
export const RELEASES_URL = `${REPO_URL}/releases`;
export const ISSUES_URL = `${REPO_URL}/issues`;
export const README_EN_URL = `${REPO_URL}/blob/main/README.md`;
export const README_ZH_URL = `${REPO_URL}/blob/main/README.zh-CN.md`;
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;

// TODO(placeholder): additional links (changelog page, demo video, download
// mirror…) have no public URL yet. Add them here when they exist.
