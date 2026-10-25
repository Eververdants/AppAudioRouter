import { useTranslation } from 'react-i18next';
import { Section } from '@/components/Section';
import { SpotlightCard } from '@/components/SpotlightCard';
import {
  DelayIcon,
  FeedIcon,
  LevelIcon,
  MemoryIcon,
  RouteIcon,
  VolumeIcon,
} from '@/components/icons';

const FEATURE_KEYS = ['routing', 'feed', 'delay', 'volume', 'level', 'memory'] as const;

const FEATURE_ICONS: Record<(typeof FEATURE_KEYS)[number], typeof RouteIcon> = {
  routing: RouteIcon,
  feed: FeedIcon,
  delay: DelayIcon,
  volume: VolumeIcon,
  level: LevelIcon,
  memory: MemoryIcon,
};

/** The six capability cards. Every claim is a straight restatement of the
 *  app README's feature list — nothing here is aspirational. The app's 2.3.0
 *  headline, "one app → another app's input", is the second card; per-program
 *  level alignment and the failure-visible mirror each have their own. */
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
            <SpotlightCard key={key} delay={index * 0.06} className="p-6">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-muted text-accent transition-transform duration-300 group-hover:-rotate-6 group-hover:scale-110">
                <FeatureIcon className="h-6 w-6" />
              </span>
              <h3 className="mt-4 text-base font-semibold text-text-primary">
                {t(`features.items.${key}.title`)}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                {t(`features.items.${key}.description`)}
              </p>
            </SpotlightCard>
          );
        })}
      </div>

      {/* Requirements render as a full-width band rather than a sixth grid cell:
          the capability grid is a clean 3×2, and the three requirements read
          better as a single row than as a squeezed card. */}
      <div className="mt-4 rounded-2xl border border-glass bg-glass p-6 shadow-glass backdrop-blur-xl">
        <h3 className="text-base font-semibold text-text-primary">
          {t('install.requirements.title')}
        </h3>
        <ul className="mt-4 grid gap-3 sm:grid-cols-3 text-sm leading-relaxed text-text-secondary">
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
      </div>
    </Section>
  );
}
