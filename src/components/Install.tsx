import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Section } from '@/components/Section';
import { RELEASES_URL } from '@/lib/site';
import { DownloadIcon } from '@/components/icons';

const STEP_KEYS = ['one', 'two', 'three'] as const;

const BUILD_COMMANDS = `git clone https://github.com/Eververdants/AppAudioRouter.git
cd AppAudioRouter
pnpm install
pnpm tauri build   # installers in src-tauri/target/release/bundle`;

/** Download guidance: the README's three install steps, the system
 *  requirements (rendered as a strip) and the from-source commands. */
export function Install() {
  const { t } = useTranslation();

  return (
    <Section
      id="install"
      eyebrow={t('install.eyebrow')}
      title={t('install.title')}
      description={t('install.description')}
    >
      <div className="grid gap-4 md:grid-cols-3">
        {STEP_KEYS.map((key, index) => (
          <motion.ol
            key={key}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-60px' }}
            transition={{ duration: 0.45, delay: index * 0.08, ease: 'easeOut' }}
            className="relative rounded-2xl border border-glass bg-glass p-6 shadow-glass backdrop-blur-xl"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent font-mono text-sm font-bold text-white shadow-glow dark:text-bg-primary">
              {index + 1}
            </span>
            <h3 className="mt-4 text-base font-semibold text-text-primary">
              {t(`install.steps.${key}.title`)}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-text-secondary">
              {t(`install.steps.${key}.description`)}
            </p>
          </motion.ol>
        ))}
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-60px' }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        className="mt-10 flex flex-col items-center gap-6 rounded-2xl border border-glass bg-glass p-8 text-center shadow-glass-lg backdrop-blur-xl"
      >
        <a
          href={RELEASES_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-sm font-semibold text-white shadow-glow transition-colors hover:bg-accent-hover dark:text-bg-primary"
        >
          <DownloadIcon className="h-4 w-4" />
          {t('install.ctaReleases')}
        </a>

        <div className="w-full max-w-xl rounded-xl border border-border bg-bg-secondary p-4 text-left">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
              {t('install.build.title')}
            </span>
            <span className="rounded bg-bg-tertiary px-1.5 py-px text-[10px] font-medium leading-4 text-text-muted">
              {t('install.build.caption')}
            </span>
          </div>
          <pre className="mt-3 overflow-x-auto font-mono text-xs leading-6 text-text-secondary">
            <code>{BUILD_COMMANDS}</code>
          </pre>
          <p className="mt-2 text-xs text-text-muted">{t('install.build.description')}</p>
        </div>
      </motion.div>
    </Section>
  );
}
