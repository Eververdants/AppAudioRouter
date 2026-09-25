import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { Section } from '@/components/Section';
import { DelayIcon, MemoryIcon, NoDriverIcon, RouteIcon, VolumeIcon } from '@/components/icons';

const FEATURE_KEYS = ['routing', 'delay', 'volume', 'native', 'memory'] as const;

const FEATURE_ICONS: Record<(typeof FEATURE_KEYS)[number], typeof RouteIcon> = {
  routing: RouteIcon,
  delay: DelayIcon,
  volume: VolumeIcon,
  native: NoDriverIcon,
  memory: MemoryIcon,
};

/** The five capability cards. Every claim is a straight restatement of the
 *  app README's feature list — nothing here is aspirational. */
export function Features() {
  const { t } = useTranslation();

  return (
    <Section
      id="features"
      eyebrow={t('features.eyebrow')}
      title={t('features.title')}
      description={t('features.description')}
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURE_KEYS.map((key, index) => {
          const FeatureIcon = FEATURE_ICONS[key];
          return (
            <motion.article
              key={key}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-60px' }}
              transition={{ duration: 0.45, delay: index * 0.06, ease: 'easeOut' }}
              className="rounded-2xl border border-glass bg-glass p-6 shadow-glass backdrop-blur-xl transition-shadow hover:shadow-glow-lg"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-muted text-accent">
                <FeatureIcon className="h-6 w-6" />
              </span>
              <h3 className="mt-4 text-base font-semibold text-text-primary">
                {t(`features.items.${key}.title`)}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                {t(`features.items.${key}.description`)}
              </p>
            </motion.article>
          );
        })}

        {/* Requirements card fills the 3×2 grid's last cell without padding the
            copy: it restates what the README lists under Requirements. */}
        <motion.aside
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-60px' }}
          transition={{ duration: 0.45, delay: 0.3, ease: 'easeOut' }}
          className="rounded-2xl border border-glass bg-glass p-6 shadow-glass backdrop-blur-xl"
        >
          <h3 className="text-base font-semibold text-text-primary">
            {t('install.requirements.title')}
          </h3>
          <ul className="mt-4 space-y-2.5 text-sm leading-relaxed text-text-secondary">
            <li className="flex gap-2">
              <span className="mt-[7px] h-1.5 w-1.5 flex-none rounded-full bg-accent" />
              {t('install.requirements.os')}
            </li>
            <li className="flex gap-2">
              <span className="mt-[7px] h-1.5 w-1.5 flex-none rounded-full bg-accent" />
              {t('install.requirements.webview')}
            </li>
            <li className="flex gap-2">
              <span className="mt-[7px] h-1.5 w-1.5 flex-none rounded-full bg-accent" />
              {t('install.requirements.noDriver')}
            </li>
          </ul>
        </motion.aside>
      </div>
    </Section>
  );
}
