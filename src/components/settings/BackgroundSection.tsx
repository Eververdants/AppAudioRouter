import { useTranslation } from 'react-i18next';
import { Row } from '@/components/settings/Row';
import { Switch } from '@/components/ui/Switch';
import { useRouterStore } from '@/stores/routerStore';

/** How the window behaves when it is not being looked at, as the page's third
 *  section. Both switches write `app-settings.json` on the Rust side, so both
 *  are awaited (`void`) exactly as the page always awaited them. */
export function BackgroundSection() {
  const { t } = useTranslation();
  const closeToTray = useRouterStore((s) => s.closeToTray);
  const toggleCloseToTray = useRouterStore((s) => s.toggleCloseToTray);
  const autostart = useRouterStore((s) => s.autostart);
  const toggleAutostart = useRouterStore((s) => s.toggleAutostart);

  return (
    <>
      <Row title={t('settings.closeToTray')} desc={t('settings.closeToTrayDesc')}>
        <Switch
          checked={closeToTray}
          onChange={() => void toggleCloseToTray()}
          label={t('settings.closeToTray')}
        />
      </Row>
      <Row title={t('settings.autostart')} desc={t('settings.autostartDesc')}>
        <Switch
          checked={autostart}
          onChange={() => void toggleAutostart()}
          label={t('settings.autostart')}
        />
      </Row>
    </>
  );
}
