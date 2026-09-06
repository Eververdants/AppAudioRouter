/** i18next setup: bundled zh-CN / en resources, system-language detection, localStorage persistence. */

import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';

export type Language = 'zh-CN' | 'en';

const STORAGE_KEY = 'aar-language';

const resources = {
  'zh-CN': { translation: zhCN },
  en: { translation: en },
} as const;

function getInitialLanguage(): Language {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'zh-CN' || stored === 'en') return stored;
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

void i18next.use(initReactI18next).init({
  resources,
  lng: getInitialLanguage(),
  fallbackLng: 'en',
  // React escapes rendered text itself; escaping here would double-encode.
  interpolation: { escapeValue: false },
});

i18next.on('languageChanged', (lng) => {
  document.documentElement.lang = lng;
  localStorage.setItem(STORAGE_KEY, lng);
});

/** The active UI language, normalized for callers outside React. */
export function currentLanguage(): Language {
  return i18next.language.startsWith('zh') ? 'zh-CN' : 'en';
}
