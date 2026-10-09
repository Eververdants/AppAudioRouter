/**
 * Build-time site metadata: turns `index.html` into a template, emits one
 * HTML document per language, and fills the tokens in the other static files
 * under `public/`.
 *
 * Everything a crawler reads without executing JavaScript — the title, the
 * description, the Open Graph tags, the JSON-LD graph and the `<noscript>`
 * fallback — is generated from the same locale files the app renders from, so
 * the static copy and the interactive copy cannot drift apart. Most answer
 * engines (GPTBot, ClaudeBot, PerplexityBot) fetch raw HTML and never run the
 * bundle, which is what makes this file matter.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Plugin } from 'vite';
import enJson from '../src/i18n/locales/en.json';
import zhJson from '../src/i18n/locales/zh-CN.json';
import { FAQ_KEYS } from '../src/lib/faq';
import {
  DATE_PUBLISHED,
  DEFAULT_LANGUAGE,
  ISSUES_URL,
  LICENSE_URL,
  ORG_NAME,
  ORG_URL,
  README_EN_URL,
  README_ZH_URL,
  RELEASES_URL,
  REPO_URL,
  SCREENSHOT_DARK,
  SCREENSHOT_LIGHT,
  SITE_LANGUAGES,
  SITE_NAME,
  SITE_URL,
  VERSION,
  urlForLanguage,
} from '../src/lib/site';

interface Copy {
  title: string;
  description: string;
}

interface Locale {
  meta: Copy & { ogDescription: string; imageAlt: string };
  hero: Copy & { tagline: string; badge: string; note: string };
  features: Copy & { items: Record<string, Copy> };
  scenarios: Copy & { screenshotCaption: string; items: Record<string, Copy & { tag: string }> };
  install: Copy & {
    ctaReleases: string;
    steps: Record<string, Copy>;
    requirements: { title: string; os: string; webview: string; noDriver: string };
  };
  faq: Copy & { items: Record<string, { question: string; answer: string }> };
  footer: { tagline: string };
}

const LOCALES: Record<string, Locale> = {
  en: enJson as unknown as Locale,
  'zh-CN': zhJson as unknown as Locale,
};

type Variant = (typeof SITE_LANGUAGES)[number];

interface Context {
  version: string;
  buildDate: string;
  base: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** JSON-LD lives inside a `<script>` element, so a literal `</` in any string
 *  would close it early. Escaping `<` as a JSON escape keeps the payload valid
 *  JSON and inert as HTML. */
function escapeJsonLd(value: string): string {
  return value.replace(/</g, '\\u003c');
}

function pick<Item>(items: Record<string, Item>, keys: readonly string[]): Item[] {
  return keys.map((key) => items[key]).filter((item): item is Item => item !== undefined);
}

/* ------------------------------------------------------------------ JSON-LD */

const KEYWORDS = [
  'per-app audio routing',
  'route app audio to multiple devices',
  'play same sound on two devices Windows',
  'Windows audio router',
  'audio delay compensation',
  'Bluetooth latency fix',
  'per-device volume balance',
  'VB-CABLE alternative',
  'WASAPI process loopback',
  '分应用音频路由',
  '一个应用同时输出到多台设备',
  '音频延迟补偿',
  '蓝牙耳机延迟',
  '虚拟声卡替代',
];

const FEATURE_LIST = [
  '一个应用同时输出到多台播放设备(one app → many devices)',
  '逐设备延迟补偿(per-device delay compensation)',
  '逐设备音量平衡(per-device volume balance)',
  '无需虚拟声卡驱动(no virtual audio driver)',
  '按程序自动记忆路由(auto-remember routes per executable)',
  '停止路由后把程序交还系统默认设备(stopping releases the fixed output device)',
  '设置 → 重置每应用音频输出(Settings → Reset per-app output)',
  '系统关键进程拒绝路由(routes for system-critical processes are refused)',
];

function jsonLd(variant: Variant, locale: Locale, context: Context): string {
  const url = urlForLanguage(variant.code);
  const websiteId = `${SITE_URL}#website`;
  const orgId = `${ORG_URL}#org`;
  const appId = `${SITE_URL}#app`;
  const lightId = `${url}#screenshot-light`;

  const image = (path: string, id: string) => ({
    '@type': 'ImageObject',
    '@id': id,
    url: new URL(path, SITE_URL).href,
    contentUrl: new URL(path, SITE_URL).href,
    width: 1800,
    height: 1360,
    encodingFormat: 'image/png',
    caption: locale.scenarios.screenshotCaption,
    inLanguage: variant.code,
  });

  return escapeJsonLd(
    JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'Organization',
          '@id': orgId,
          name: ORG_NAME,
          url: ORG_URL,
          sameAs: [REPO_URL],
        },
        {
          '@type': 'WebSite',
          '@id': websiteId,
          url: SITE_URL,
          name: SITE_NAME,
          description: locale.footer.tagline,
          inLanguage: SITE_LANGUAGES.map((entry) => entry.code),
          publisher: { '@id': orgId },
        },
        {
          '@type': 'WebPage',
          '@id': `${url}#webpage`,
          url,
          name: locale.meta.title,
          description: locale.meta.description,
          inLanguage: variant.code,
          isPartOf: { '@id': websiteId },
          about: { '@id': appId },
          primaryImageOfPage: { '@id': lightId },
          datePublished: DATE_PUBLISHED,
          dateModified: context.buildDate,
        },
        {
          '@type': 'SoftwareApplication',
          '@id': appId,
          name: SITE_NAME,
          alternateName: 'AAR',
          url,
          image: { '@id': lightId },
          screenshot: [
            image(SCREENSHOT_LIGHT, lightId),
            image(SCREENSHOT_DARK, `${url}#screenshot-dark`),
          ],
          downloadUrl: RELEASES_URL,
          // Release tags in the main repository carry a `v` prefix.
          releaseNotes: `${RELEASES_URL}/tag/v${context.version}`,
          operatingSystem: 'Windows 10, Windows 11 (64-bit)',
          applicationCategory: 'MultimediaApplication',
          applicationSubCategory: 'Per-app audio routing',
          softwareVersion: context.version,
          softwareRequirements:
            'WebView2 Runtime — bundled with Windows 11, present on any Windows 10 with Microsoft Edge. No audio driver, no service, no third-party executable.',
          license: LICENSE_URL,
          isAccessibleForFree: true,
          inLanguage: SITE_LANGUAGES.map((entry) => entry.code),
          description: locale.meta.description,
          keywords: KEYWORDS.join(', '),
          featureList: FEATURE_LIST,
          datePublished: DATE_PUBLISHED,
          dateModified: context.buildDate,
          author: { '@id': orgId },
          publisher: { '@id': orgId },
          sameAs: [REPO_URL, RELEASES_URL, ISSUES_URL],
          offers: {
            '@type': 'Offer',
            price: '0',
            priceCurrency: 'USD',
            availability: 'https://schema.org/InStock',
            url: RELEASES_URL,
          },
        },
      ],
    }),
  );
}

/* ----------------------------------------------------------------- noscript */

function listItems(items: string[]): string {
  return items.map((item) => `          <li>${item}</li>`).join('\n');
}

/** The whole page in plain semantic HTML, for clients that never run the
 *  bundle. Inline styles only: this markup has to survive a missing sheet. */
function noScript(variant: Variant, locale: Locale, context: Context): string {
  const alternate = SITE_LANGUAGES.find((entry) => entry.code !== variant.code);
  const alternateLink = alternate
    ? `        <p>
          <a href="${urlForLanguage(alternate.code)}">${
            alternate.code === 'en' ? 'English version' : '简体中文版本'
          }</a>
        </p>`
    : '';

  return `
      <div
        style="
          max-width: 44rem;
          margin: 3rem auto;
          padding: 0 1.25rem;
          font-family: system-ui, sans-serif;
          line-height: 1.65;
        "
      >
        <h1 style="font-size: 1.9rem; line-height: 1.25; margin: 0 0 0.5rem">${SITE_NAME}</h1>
        <p style="margin: 0 0 1rem">
          ${escapeHtml(locale.hero.badge.replace('{{version}}', context.version))}
        </p>
        <p>${escapeHtml(locale.hero.tagline)}</p>
        <p>${escapeHtml(locale.hero.description)}</p>

        <h2 style="font-size: 1.3rem; margin: 2rem 0 0.5rem">
          ${escapeHtml(locale.features.title)}
        </h2>
        <p>${escapeHtml(locale.features.description)}</p>
        <ul style="padding-left: 1.25rem">
${listItems(
  Object.values(locale.features.items).map(
    (item) => `<strong>${escapeHtml(item.title)}</strong> — ${escapeHtml(item.description)}`,
  ),
)}
        </ul>

        <h2 style="font-size: 1.3rem; margin: 2rem 0 0.5rem">
          ${escapeHtml(locale.scenarios.title)}
        </h2>
        <ul style="padding-left: 1.25rem">
${listItems(
  Object.values(locale.scenarios.items).map(
    (item) => `<strong>${escapeHtml(item.title)}</strong> — ${escapeHtml(item.description)}`,
  ),
)}
        </ul>
        <p>${escapeHtml(locale.scenarios.screenshotCaption)}</p>

        <h2 style="font-size: 1.3rem; margin: 2rem 0 0.5rem">
          ${escapeHtml(locale.install.title)}
        </h2>
        <ol style="padding-left: 1.25rem">
${listItems(Object.values(locale.install.steps).map((step) => escapeHtml(step.description)))}
        </ol>
        <h3 style="font-size: 1.05rem; margin: 1.5rem 0 0.4rem">
          ${escapeHtml(locale.install.requirements.title)}
        </h3>
        <ul style="padding-left: 1.25rem">
${listItems([
  escapeHtml(locale.install.requirements.os),
  escapeHtml(locale.install.requirements.webview),
  escapeHtml(locale.install.requirements.noDriver),
])}
        </ul>

        <h2 style="font-size: 1.3rem; margin: 2rem 0 0.5rem">${escapeHtml(locale.faq.title)}</h2>
        <dl style="margin: 0">
${pick(locale.faq.items, FAQ_KEYS)
  .map(
    (item) =>
      `          <dt style="font-weight: 600; margin-top: 1rem">${escapeHtml(item.question)}</dt>
          <dd style="margin: 0.25rem 0 0">${escapeHtml(item.answer)}</dd>`,
  )
  .join('\n')}
        </dl>

        <h2 style="font-size: 1.3rem; margin: 2rem 0 0.5rem">Links</h2>
        <ul style="padding-left: 1.25rem">
${listItems([
  `<a href="${RELEASES_URL}">${escapeHtml(locale.install.ctaReleases)}</a>`,
  `<a href="${REPO_URL}">GitHub</a>`,
  `<a href="${README_EN_URL}">README (English)</a>`,
  `<a href="${README_ZH_URL}">README (简体中文)</a>`,
  `<a href="${LICENSE_URL}">MIT License</a>`,
])}
        </ul>
${alternateLink}
      </div>`;
}

/* ------------------------------------------------------------------- render */

function hreflangLinks(): string {
  const links = SITE_LANGUAGES.map(
    (entry) =>
      `    <link rel="alternate" hreflang="${entry.hreflang}" href="${urlForLanguage(entry.code)}" />`,
  );
  // The root URL is the one that picks a language from the visitor's own
  // settings, which is exactly what x-default is for.
  links.push(`    <link rel="alternate" hreflang="x-default" href="${SITE_URL}" />`);
  return links.join('\n');
}

/** Tokens that mean the same thing in every file, whatever the language. */
function sharedTokens(context: Context): Record<string, string> {
  const tokens: Record<string, string> = {
    '%APP_VERSION%': context.version,
    '%BUILD_DATE%': context.buildDate,
    '%SITE_URL%': SITE_URL,
    '%BASE_URL%': context.base,
  };
  for (const entry of SITE_LANGUAGES) {
    if (entry.code === DEFAULT_LANGUAGE) continue;
    tokens[`%SITE_URL_${entry.code.toUpperCase()}%`] = urlForLanguage(entry.code);
  }
  return tokens;
}

function replaceTokens(source: string, tokens: Record<string, string>): string {
  return source.replace(/%[A-Z0-9_-]+%/g, (token) => tokens[token] ?? token);
}

function renderIndexHtml(html: string, variant: Variant, context: Context): string {
  const locale = LOCALES[variant.code];
  if (!locale) throw new Error(`[site-meta] no locale bundled for "${variant.code}"`);

  const url = urlForLanguage(variant.code);
  const alternates = SITE_LANGUAGES.filter((entry) => entry.code !== variant.code).map(
    (entry) =>
      `    <meta property="og:locale:alternate" content="${escapeHtml(entry.ogLocale)}" />`,
  );

  return replaceTokens(html, {
    ...sharedTokens(context),
    '%HTML_LANG%': variant.code,
    '%CANONICAL%': url,
    '%HREFLANG%': hreflangLinks(),
    '%TITLE%': escapeHtml(locale.meta.title),
    '%DESCRIPTION%': escapeHtml(locale.meta.description),
    '%KEYWORDS%': escapeHtml(KEYWORDS.join(', ')),
    '%OG_URL%': url,
    '%OG_LOCALE%': variant.ogLocale,
    '%OG_LOCALE_ALTERNATE%': alternates.join('\n'),
    '%OG_TITLE%': escapeHtml(locale.meta.title),
    '%OG_DESCRIPTION%': escapeHtml(locale.meta.ogDescription),
    '%OG_IMAGE%': new URL(SCREENSHOT_LIGHT, SITE_URL).href,
    '%OG_IMAGE_ALT%': escapeHtml(locale.meta.imageAlt),
    '%AUTHOR%': escapeHtml(ORG_NAME),
    '%JSONLD%': jsonLd(variant, locale, context),
    '%NOSCRIPT%': noScript(variant, locale, context),
  });
}

/* ------------------------------------------------------------------- plugin */

const TEXT_ASSETS = /\.(?:html|txt|xml|webmanifest)$/;

/** Fills the metadata tokens and writes one HTML document per language. */
export function siteMeta(base: string): Plugin {
  // The build machine's own calendar day: `dateModified` and the sitemap's
  // `lastmod` should not read as yesterday just because the build ran before
  // midnight UTC.
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const context: Context = {
    version: VERSION,
    buildDate: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    base,
  };
  const defaultVariant = SITE_LANGUAGES.find((entry) => entry.code === DEFAULT_LANGUAGE);
  if (!defaultVariant) throw new Error(`[site-meta] unknown default language ${DEFAULT_LANGUAGE}`);

  return {
    name: 'aar-site-meta',
    // Dev never reaches `writeBundle`, so the template is filled on the way
    // through; a build leaves it alone and does the whole job once at the end.
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        return ctx.server ? renderIndexHtml(html, defaultVariant, context) : html;
      },
    },
    // Last hook of the build: `index.html` and everything from `public/` is on
    // disk by now, so there is no plugin ordering to get wrong.
    writeBundle(options) {
      const outDir = resolve(options.dir ?? 'dist');
      const template = readFileSync(resolve(outDir, 'index.html'), 'utf8');

      for (const variant of SITE_LANGUAGES) {
        const file = resolve(outDir, variant.path, 'index.html');
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, renderIndexHtml(template, variant, context));
      }

      const tokens = sharedTokens(context);
      for (const name of readdirSync(outDir)) {
        if (name === 'index.html' || !TEXT_ASSETS.test(name)) continue;
        const file = resolve(outDir, name);
        writeFileSync(file, replaceTokens(readFileSync(file, 'utf8'), tokens));
      }
    },
  };
}
