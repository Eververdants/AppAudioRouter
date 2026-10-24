import { useTranslation } from 'react-i18next';
import { ROW_BUTTON_CLASS, Row } from '@/components/settings/Row';
import { openHelpPage } from '@/lib/invoke';
import { useRouterStore } from '@/stores/routerStore';

/** The version, and the two ways back to an explanation, as the page's last
 *  section. */
export function AboutSection({ language }: { language: 'zh-CN' | 'en' }) {
  const { t } = useTranslation();
  const replayWizard = useRouterStore((s) => s.replayWizard);
  const raiseError = useRouterStore((s) => s.raiseError);

  return (
    <>
      {/* The tour is acknowledged once per version and never returns on
                      its own, and there is no other explanation inside the window
                      — so both ways back to "what did that screen say" live here,
                      beside the version number a bug report would quote. */}
      <Row title={t('settings.replayTour')} desc={t('settings.replayTourDesc')}>
        <button type="button" onClick={replayWizard} className={ROW_BUTTON_CLASS}>
          {t('settings.replayTourAction')}
        </button>
      </Row>
      <Row title={t('settings.help')} desc={t('settings.helpDesc')}>
        <button
          type="button"
          onClick={() =>
            void openHelpPage(language.startsWith('zh') ? 'readme-zh' : 'readme').catch(() => {
              raiseError(t('settings.helpFailed'));
            })
          }
          className={ROW_BUTTON_CLASS}
        >
          {t('settings.helpAction')}
        </button>
      </Row>
      <div className="py-3">
        <div className="mb-1 flex items-center justify-between gap-4">
          <span className="text-[13px] font-medium text-text-primary">App Audio Router</span>
          {/* The version is a fact, not an achievement: set in the same
                        monospaced muted type as every other number in the app. */}
          <span className="font-mono text-xs tabular-nums text-text-muted">v{__APP_VERSION__}</span>
        </div>
        <p className="max-w-[52ch] text-[11px] leading-relaxed text-text-muted">
          {t('settings.aboutDesc')}
        </p>
      </div>
    </>
  );
}
