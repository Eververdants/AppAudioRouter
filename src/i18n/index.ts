/** i18next setup: bundled zh-CN / en resources, system-language detection,
 *  localStorage persistence. Mirrors the desktop app's i18n bootstrap, with a
 *  website-specific storage key so the two preferences stay independent. */

import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { SITE_LANGUAGES } from '@/lib/site';
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';

export type Language = 'zh-CN' | 'en';

const STORAGE_KEY = 'aar-website-language';

const resources = {
  'zh-CN': { translation: zhCN },
  en: { translation: en },
} as const;

/** True when the URL itself promises a language, as `/en/` does. A path beats
 *  the stored preference: whoever opened that link — a reader or a crawler —
 *  was told which language they would get. */
function languageFromPath(): Language | null {
  return /\/en\/?$/.test(window.location.pathname) ? 'en' : null;
}

function getInitialLanguage(): Language {
  const fromPath = languageFromPath();
  if (fromPath) return fromPath;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'zh-CN' || stored === 'en') return stored;
  } catch {
    /* storage may be unavailable; fall through to the system language */
  }
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

function setTagContent(selector: string, value: string) {
  document.head.querySelector(selector)?.setAttribute('content', value);
}

/** Keeps the head in step with the language on screen. The build fills these
 *  tags for the URL's own language; a reader who switches in place should not
 *  be left sharing or indexing a description in the other one. */
function syncDocumentMeta(language: Language) {
  const ogLocale = SITE_LANGUAGES.find((entry) => entry.code === language)?.ogLocale ?? 'en_US';
  const title = i18next.t('meta.title');
  const description = i18next.t('meta.description');
  const ogDescription = i18next.t('meta.ogDescription');
  const imageAlt = i18next.t('meta.imageAlt');

  document.title = title;
  setTagContent('meta[name="description"]', description);
  setTagContent('meta[property="og:title"]', title);
  setTagContent('meta[property="og:description"]', ogDescription);
  setTagContent('meta[property="og:locale"]', ogLocale);
  setTagContent('meta[property="og:image:alt"]', imageAlt);
  setTagContent('meta[name="twitter:title"]', title);
  setTagContent('meta[name="twitter:description"]', ogDescription);
  setTagContent('meta[name="twitter:image:alt"]', imageAlt);
}

void i18next
  .use(initReactI18next)
  .init({
    resources,
    lng: getInitialLanguage(),
    fallbackLng: 'en',
    // React escapes rendered text itself; escaping here would double-encode.
    interpolation: { escapeValue: false },
  })
  .then(() => {
    // The stored or system language can differ from the one the HTML was built
    // for, so the head is synced once resources are ready, not only on switch.
    syncDocumentMeta(currentLanguage());
  })
  .catch((error) => {
    console.warn('[i18n] initialization failed', error);
  });

i18next.on('languageChanged', (lng) => {
  document.documentElement.lang = lng;
  syncDocumentMeta(lng.startsWith('zh') ? 'zh-CN' : 'en');
  try {
    localStorage.setItem(STORAGE_KEY, lng);
  } catch {
    /* storage may be unavailable; the preference just does not persist */
  }
});

/** The active UI language, normalized for callers outside React. */
export function currentLanguage(): Language {
  return i18next.language.startsWith('zh') ? 'zh-CN' : 'en';
}
