/** i18next setup: bundled zh-CN / en resources, system-language detection,
 *  localStorage persistence. Mirrors the desktop app's i18n bootstrap, with a
 *  website-specific storage key so the two preferences stay independent. */

import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';

export type Language = 'zh-CN' | 'en';

const STORAGE_KEY = 'aar-website-language';

const resources = {
  'zh-CN': { translation: zhCN },
  en: { translation: en },
} as const;

function getInitialLanguage(): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'zh-CN' || stored === 'en') return stored;
  } catch {
    /* storage may be unavailable; fall through to the system language */
  }
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
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
  .catch((error) => {
    console.warn('[i18n] initialization failed', error);
  });

i18next.on('languageChanged', (lng) => {
  document.documentElement.lang = lng;
  document.title = i18next.t('meta.title');
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
