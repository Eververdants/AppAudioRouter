import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { Section } from '@/components/Section';
import { SpotlightCard } from '@/components/SpotlightCard';
import { RELEASES_URL } from '@/lib/site';
import { CheckIcon, CopyIcon, DownloadIcon } from '@/components/icons';

const STEP_KEYS = ['one', 'two', 'three'] as const;

const BUILD_COMMANDS = `git clone https://github.com/Eververdants/AppAudioRouter.git
cd AppAudioRouter
pnpm install
pnpm tauri build   # installers in src-tauri/target/release/bundle`;

/** Download guidance: the README's three install steps, the system
 *  requirements (rendered as a strip) and the from-source commands. */
export function Install() {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const copyCommands = async () => {
    try {
      await navigator.clipboard.writeText(BUILD_COMMANDS);
      setCopied(true);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable (non-secure context); the text stays selectable */
    }
  };

  return (
    <Section
      id="install"
      eyebrow={t('install.eyebrow')}
      title={t('install.title')}
      description={t('install.description')}
    >
      <div className="grid gap-4 md:grid-cols-3">
        {STEP_KEYS.map((key, index) => (
          <SpotlightCard key={key} delay={index * 0.08} className="p-6">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent font-mono text-sm font-bold text-white shadow-glow transition-transform duration-300 group-hover:scale-110 dark:text-bg-primary">
              {index + 1}
            </span>
            <h3 className="mt-4 text-base font-semibold text-text-primary">
              {t(`install.steps.${key}.title`)}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-text-secondary">
              {t(`install.steps.${key}.description`)}
            </p>
          </SpotlightCard>
        ))}
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-60px' }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        className="mt-10 flex flex-col items-center gap-6 rounded-2xl border border-glass bg-glass p-8 text-center shadow-glass-lg backdrop-blur-xl"
      >
        <motion.a
          href={RELEASES_URL}
          target="_blank"
          rel="noreferrer"
          whileHover={{ y: -2 }}
          whileTap={{ scale: 0.97 }}
          className="group relative inline-flex items-center gap-2 overflow-hidden rounded-full bg-accent px-6 py-3 text-sm font-semibold text-white shadow-glow transition-colors hover:bg-accent-hover dark:text-bg-primary"
        >
          <DownloadIcon className="h-4 w-4 transition-transform duration-300 group-hover:translate-y-0.5" />
          {t('install.ctaReleases')}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 -translate-x-[110%] bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-700 ease-out group-hover:translate-x-[110%]"
          />
        </motion.a>

        <div className="w-full max-w-xl rounded-xl border border-border bg-bg-secondary p-4 text-left">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
              {t('install.build.title')}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="rounded bg-bg-tertiary px-1.5 py-px text-[10px] font-medium leading-4 text-text-muted">
                {t('install.build.caption')}
              </span>
              <motion.button
                type="button"
                whileTap={{ scale: 0.92 }}
                onClick={copyCommands}
                title={t(copied ? 'install.build.copied' : 'install.build.copy')}
                className={`flex items-center gap-1.5 rounded-full border border-glass px-2.5 py-1 text-[10px] font-medium transition-colors ${
                  copied ? 'text-success' : 'text-text-muted hover:text-accent'
                }`}
              >
                {copied ? <CheckIcon className="h-3 w-3" /> : <CopyIcon className="h-3 w-3" />}
                {t(copied ? 'install.build.copied' : 'install.build.copy')}
              </motion.button>
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
