import { useTranslation } from 'react-i18next';
import type { SettingsSection } from '@/components/settings/Rail';

/**
 * The rail's name for one section — the same words the rail's rows wear, and
 * the words the section's own heading rides.
 *
 * A hook rather than a prop, because two surfaces need exactly this sentence:
 * the nav (which lists every section) and the content column (which says which
 * one arrived). A second table of keys would be a second name for one section.
 */
export function useSectionLabel(): (id: SettingsSection) => string {
  const { t } = useTranslation();
  // Written out rather than indexed by a template string: the i18n keys are
  // type-checked, and `settings.${id}` would defeat that.
  return (id: SettingsSection): string => {
    switch (id) {
      case 'appearance':
        return t('settings.appearance');
      case 'routing':
        return t('settings.routing');
      case 'background':
        return t('settings.background');
      case 'delays':
        return t('settings.delays');
      case 'levels':
        return t('settings.sourceLevels');
      case 'about':
        return t('settings.about');
    }
  };
}
