import { useState } from 'react';
import { motion, useMotionValueEvent, useScroll } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@/hooks/useTheme';
import { useScrollSpy } from '@/hooks/useScrollSpy';
import type { Language } from '@/i18n';
import { REPO_URL } from '@/lib/site';
import { AnimatePresence } from 'framer-motion';
import { GitHubIcon, MoonIcon, SunIcon } from '@/components/icons';

const NAV_ITEMS = [
  { href: '#features', key: 'nav.features' },
  { href: '#scenarios', key: 'nav.scenarios' },
  { href: '#install', key: 'nav.install' },
  { href: '#faq', key: 'nav.faq' },
] as const;

const SECTION_IDS = NAV_ITEMS.map((item) => item.href.slice(1));

/** Sticky glass header, styled after the app's frameless title bar: icon +
 *  name on the left, glass panel with a hairline border, controls on the
 *  right. Deepens its shadow once the page scrolls and carries a sliding
 *  highlight on the link of the section currently being read. */
export function Header() {
  const { t, i18n } = useTranslation();
  const { theme, toggle } = useTheme();
  const activeSection = useScrollSpy(SECTION_IDS);

  const { scrollY } = useScroll();
  const [scrolled, setScrolled] = useState(false);
  useMotionValueEvent(scrollY, 'change', (value) => setScrolled(value > 8));

  const language: Language = i18n.language.startsWith('zh') ? 'zh-CN' : 'en';
  const toggleLanguage = () => void i18n.changeLanguage(language === 'zh-CN' ? 'en' : 'zh-CN');

  return (
    <header
      className={`sticky top-0 z-40 border-b border-glass backdrop-blur-xl transition-shadow duration-300 ${
        scrolled ? 'bg-glass-strong shadow-glass-lg' : 'bg-glass'
      }`}
    >
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <a href="#top" className="flex min-w-0 items-center gap-2.5">
          <img src={`${import.meta.env.BASE_URL}icon.png`} alt="" className="h-7 w-7 rounded" />
          <span className="truncate text-sm font-semibold text-text-primary">App Audio Router</span>
          <span className="hidden rounded bg-accent-muted px-1.5 py-px text-[10px] font-medium leading-4 text-accent sm:inline">
            v2.1.0
          </span>
        </a>

        <nav className="hidden items-center gap-1 md:flex" aria-label={t('nav.features')}>
          {NAV_ITEMS.map((item) => {
            const isActive = activeSection === item.href.slice(1);
            return (
              <a
                key={item.href}
                href={item.href}
                aria-current={isActive ? 'true' : undefined}
                className="relative rounded-full px-3.5 py-1.5 text-sm transition-colors"
              >
                {isActive && (
                  <motion.span
                    layoutId="nav-active-pill"
                    className="absolute inset-0 rounded-full bg-accent-muted"
                    transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                  />
                )}
                <span
                  className={`relative z-10 transition-colors ${
                    isActive
                      ? 'font-medium text-accent'
                      : 'text-text-secondary hover:text-text-primary'
                  }`}
                >
                  {t(item.key)}
                </span>
              </a>
            );
          })}
        </nav>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleLanguage}
            title={t('nav.language')}
            aria-label={t('nav.language')}
            className="flex h-8 items-center rounded-full border border-glass px-2.5 text-xs font-semibold text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          >
            {language === 'zh-CN' ? 'EN' : '中'}
          </button>
          <button
            type="button"
            onClick={toggle}
            title={t('nav.theme')}
            aria-label={t('nav.theme')}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-glass text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={theme}
                initial={{ rotate: -90, opacity: 0, scale: 0.6 }}
                animate={{ rotate: 0, opacity: 1, scale: 1 }}
                exit={{ rotate: 90, opacity: 0, scale: 0.6 }}
                transition={{ duration: 0.18 }}
                className="flex"
              >
                {theme === 'dark' ? (
                  <SunIcon className="h-4 w-4" />
                ) : (
                  <MoonIcon className="h-4 w-4" />
                )}
              </motion.span>
            </AnimatePresence>
          </button>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            title={t('nav.github')}
            aria-label={t('nav.github')}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-glass text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          >
            <GitHubIcon className="h-4 w-4" />
          </a>
        </div>
      </div>
    </header>
  );
}
