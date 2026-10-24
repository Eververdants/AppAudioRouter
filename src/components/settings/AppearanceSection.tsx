import { useTranslation } from 'react-i18next';
import { Row } from '@/components/settings/Row';
import { MoonIcon, SunIcon } from '@/components/settings/icons';
import { SegmentedControl } from '@/components/ui/SegmentedControl';

/** Theme and language, as the page's first section. */
export function AppearanceSection({
  theme,
  setTheme,
  language,
  setLanguage,
}: {
  theme: 'light' | 'dark';
  setTheme: (theme: 'light' | 'dark') => void;
  language: 'zh-CN' | 'en';
  setLanguage: (language: 'zh-CN' | 'en') => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Row title={t('settings.theme')}>
        <SegmentedControl
          layoutId="settings-theme-pill"
          ariaLabel={t('settings.theme')}
          value={theme}
          onChange={setTheme}
          options={[
            {
              value: 'light',
              label: (
                <span className="flex items-center gap-1">
                  {SunIcon}
                  {t('settings.themeLight')}
                </span>
              ),
              ariaLabel: t('settings.themeLight'),
            },
            {
              value: 'dark',
              label: (
                <span className="flex items-center gap-1">
                  {MoonIcon}
                  {t('settings.themeDark')}
                </span>
              ),
              ariaLabel: t('settings.themeDark'),
            },
          ]}
        />
      </Row>
      <Row title={t('settings.language')}>
        <SegmentedControl
          layoutId="settings-language-pill"
          ariaLabel={t('settings.language')}
          value={language}
          onChange={setLanguage}
          options={[
            { value: 'zh-CN', label: '中文' },
            { value: 'en', label: 'EN' },
          ]}
        />
      </Row>
    </>
  );
}
