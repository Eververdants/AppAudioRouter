import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useLanguage } from '@/hooks/useLanguage';
import type { Language } from '@/i18n';

// Language autonyms stay in their own language regardless of the UI language.
const OPTIONS: ReadonlyArray<{
  value: Language;
  label: string;
  ariaKey: 'language.chinese' | 'language.english';
}> = [
  { value: 'zh-CN', label: '中', ariaKey: 'language.chinese' },
  { value: 'en', label: 'EN', ariaKey: 'language.english' },
];

export function LanguageToggle() {
  const { t } = useTranslation();
  const { language, setLanguage } = useLanguage();

  return (
    <div
      role="group"
      aria-label={t('language.label')}
      className="flex h-9 items-center rounded-full border border-border bg-bg-secondary p-1"
    >
      {OPTIONS.map((option) => {
        const isActive = language === option.value;
        return (
          <button
            key={option.value}
            onClick={() => setLanguage(option.value)}
            aria-label={t(option.ariaKey)}
            aria-pressed={isActive}
            className={`relative flex h-7 items-center justify-center rounded-full px-2.5 text-xs font-medium transition-colors ${
              isActive ? 'text-white' : 'text-text-muted hover:text-accent'
            }`}
          >
            {isActive && (
              <motion.span
                layoutId="language-toggle-pill"
                className="absolute inset-0 rounded-full bg-accent shadow-glow"
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
              />
            )}
            <span className="relative">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
