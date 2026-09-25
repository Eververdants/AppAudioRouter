import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { RELEASES_URL, REPO_URL, VERSION } from '@/lib/site';
import { RouterIllustration } from '@/components/RouterIllustration';
import { DownloadIcon, ExternalLinkIcon } from '@/components/icons';

export function Hero() {
  const { t } = useTranslation();

  return (
    <section
      id="top"
      className="mx-auto w-full max-w-6xl px-4 pb-20 pt-14 sm:px-6 sm:pt-20 lg:px-8"
    >
      <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-8">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
        >
          <span className="inline-flex items-center gap-2 rounded-full border border-glass bg-glass px-3.5 py-1.5 text-xs font-medium text-text-secondary shadow-glass">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            {t('hero.badge', { version: VERSION })}
          </span>

          <h1 className="mt-6 text-4xl font-bold leading-tight tracking-tight text-text-primary sm:text-5xl">
            {t('hero.title')}
          </h1>

          <p className="mt-5 max-w-xl text-lg font-medium leading-relaxed text-text-secondary">
            {t('hero.tagline')}
          </p>
          <p className="mt-3 max-w-xl text-base leading-relaxed text-text-muted">
            {t('hero.description')}
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <motion.a
              href={RELEASES_URL}
              target="_blank"
              rel="noreferrer"
              whileHover={{ y: -2 }}
              whileTap={{ scale: 0.97 }}
              className="group relative inline-flex items-center gap-2 overflow-hidden rounded-full bg-accent px-6 py-3 text-sm font-semibold text-white shadow-glow transition-colors hover:bg-accent-hover dark:text-bg-primary"
            >
              <DownloadIcon className="h-4 w-4 transition-transform duration-300 group-hover:translate-y-0.5" />
              {t('hero.ctaDownload')}
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 -translate-x-[110%] bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-700 ease-out group-hover:translate-x-[110%]"
              />
            </motion.a>
            <motion.a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              whileHover={{ y: -2 }}
              whileTap={{ scale: 0.97 }}
              className="group inline-flex items-center gap-2 rounded-full border border-border bg-glass px-6 py-3 text-sm font-semibold text-text-primary transition-colors hover:bg-bg-tertiary"
            >
              <ExternalLinkIcon className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:text-accent" />
              {t('hero.ctaSource')}
            </motion.a>
          </div>

          <p className="mt-4 text-xs text-text-muted">{t('hero.note')}</p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.6, ease: 'easeOut', delay: 0.1 }}
        >
          <RouterIllustration />
        </motion.div>
      </div>
    </section>
  );
}
