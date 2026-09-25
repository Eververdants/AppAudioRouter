import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { Section } from '@/components/Section';
import { SpotlightCard } from '@/components/SpotlightCard';
import { ListenTogetherIcon, RefreshIcon, SlidersIcon, DelayIcon } from '@/components/icons';

const SCENARIO_KEYS = ['sibling', 'sync', 'balance', 'remember'] as const;

const SCENARIO_ICONS: Record<(typeof SCENARIO_KEYS)[number], typeof DelayIcon> = {
  sibling: ListenTogetherIcon,
  sync: DelayIcon,
  balance: SlidersIcon,
  remember: RefreshIcon,
};

/** Real usage patterns, one per card, each tagged with the capability that
 *  makes it possible — mirroring the examples in the app README. The pair of
 *  screenshots underneath is the same route in both themes. */
export function Scenarios() {
  const { t } = useTranslation();

  return (
    <Section
      id="scenarios"
      eyebrow={t('scenarios.eyebrow')}
      title={t('scenarios.title')}
      description={t('scenarios.description')}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {SCENARIO_KEYS.map((key, index) => {
          const ScenarioIcon = SCENARIO_ICONS[key];
          return (
            <SpotlightCard key={key} delay={index * 0.06} className="p-6">
              <div className="flex gap-4">
                <span className="flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-accent-muted text-accent transition-transform duration-300 group-hover:-rotate-6 group-hover:scale-110">
                  <ScenarioIcon className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-wider text-accent">
                    {t(`scenarios.items.${key}.tag`)}
                  </p>
                  <h3 className="mt-1.5 text-base font-semibold text-text-primary">
                    {t(`scenarios.items.${key}.title`)}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                    {t(`scenarios.items.${key}.description`)}
                  </p>
                </div>
              </div>
            </SpotlightCard>
          );
        })}
      </div>

      <motion.figure
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-60px' }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        className="mt-10"
      >
        <div className="grid gap-4 lg:grid-cols-2">
          {(['light', 'dark'] as const).map((variant) => (
            <div
              key={variant}
              className="group overflow-hidden rounded-2xl border border-glass shadow-glass-lg transition-shadow duration-300 hover:shadow-glow"
            >
              <img
                src={`${import.meta.env.BASE_URL}screenshots/app-audio-router-${variant}.png`}
                alt={t(`scenarios.screenshotAlt.${variant}`)}
                loading="lazy"
                decoding="async"
                width="1800"
                height="1360"
                className="h-auto w-full transition-transform duration-500 ease-out group-hover:scale-[1.02]"
              />
            </div>
          ))}
        </div>
        <figcaption className="mt-4 text-center text-sm text-text-muted">
          {t('scenarios.screenshotCaption')}
        </figcaption>
      </motion.figure>
    </Section>
  );
}
