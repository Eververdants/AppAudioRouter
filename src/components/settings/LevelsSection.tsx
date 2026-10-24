import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ROW_BUTTON_CLASS, Row } from '@/components/settings/Row';
import { duplicatedExecutables } from '@/components/settings/duplicatedExecutables';
import { useRouterStore } from '@/stores/routerStore';

/** Source levels, as the page's fifth section: the one click that evens them
 *  out, and the note on where the values themselves live. */
export function LevelsSection() {
  const { t } = useTranslation();
  const sessions = useRouterStore((s) => s.sessions);
  const routedPids = useRouterStore((s) => s.routedPids);
  const alignSourceLevels = useRouterStore((s) => s.alignSourceLevels);

  // Only ever disables one button, but it walks the whole session list, and
  // this page re-renders for every store field it reads — several of which
  // move whenever audio comes or goes.
  const duplicated = useMemo(
    () => duplicatedExecutables(sessions, routedPids),
    [sessions, routedPids],
  );

  return (
    <>
      {/* One click and no confirmation: evening the levels out is the
                      feature, and what it covered is reported in the log rather
                      than in a question asked before it runs. */}
      <Row title={t('settings.sourceLevelsAlign')} desc={t('settings.sourceLevelsAlignDesc')}>
        <button
          type="button"
          onClick={() => void alignSourceLevels()}
          disabled={duplicated.length === 0}
          className={ROW_BUTTON_CLASS}
        >
          {t('settings.sourceLevelsAlignAction')}
        </button>
      </Row>
      {/* The levels themselves live on the board, as the ring each
                      duplicated program's source node wears — a value in the
                      context it acts in, not a second list here saying the same
                      thing twice. */}
      <p className="py-3 text-[11px] leading-relaxed text-text-muted">
        {t('settings.sourceLevelsNote')}
      </p>
    </>
  );
}
