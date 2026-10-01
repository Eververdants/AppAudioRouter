import { useTranslation } from 'react-i18next';
import type { Language } from '@/i18n';

/** Current UI language and a setter, mirroring useTheme. */
export function useLanguage() {
  const { i18n } = useTranslation();

  // `i18n.language` is undefined until initialization completes; treat that
  // window as English rather than throwing mid-render.
  const language: Language = i18n.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
  const setLanguage = (lng: Language) => {
    void i18n.changeLanguage(lng);
  };

  return { language, setLanguage };
}
