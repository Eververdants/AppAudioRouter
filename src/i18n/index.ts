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
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'zh-CN' || stored === 'en') return stored;
  } catch {
    /* storage may be unavailable; fall through to the system language */
  }
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

/** Keep the document's declared language with the rendered one. */
function applyLanguage(lng: string): void {
  document.documentElement.lang = lng;
  try {
    localStorage.setItem(STORAGE_KEY, lng);
  } catch {
    /* storage may be unavailable; the preference just does not persist */
  }
}

const initialLanguage = getInitialLanguage();

void i18next
  .use(initReactI18next)
  .init({
    resources,
    lng: initialLanguage,
    fallbackLng: 'en',
    // React escapes rendered text itself; escaping here would double-encode.
    interpolation: { escapeValue: false },
  })
  .catch((error) => {
    console.warn('[i18n] initialization failed', error);
  });

// `languageChanged` is emitted from inside `init()` — before the listener below
// can be attached — so the language this boot chose is applied here as well.
// Left to the listener, <html lang> keeps whatever index.html hardcodes while
// the UI renders in the other language: a screen reader pronounces the whole
// page with the wrong engine, and the font fallback disagrees with the text.
applyLanguage(initialLanguage);

i18next.on('languageChanged', applyLanguage);

/** The active UI language, normalized for callers outside React. */
export function currentLanguage(): Language {
  // `language` is undefined until i18next finishes initializing — and stays
  // that way if initialization failed — while `addLog` calls this on every
  // entry. Defaulting to English keeps a broken init from breaking the log.
  return i18next.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}
