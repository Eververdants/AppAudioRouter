import { useTranslation } from 'react-i18next';
import {
  ISSUES_URL,
  LICENSE_URL,
  README_EN_URL,
  README_ZH_URL,
  RELEASES_URL,
  REPO_URL,
  VERSION,
} from '@/lib/site';
import { GitHubIcon } from '@/components/icons';

/** Footer with the repository links and licence line. */
export function Footer() {
  const { t } = useTranslation();

  const projectLinks = [
    { href: REPO_URL, key: 'footer.project.repo', external: true },
    { href: RELEASES_URL, key: 'footer.project.releases', external: true },
    { href: ISSUES_URL, key: 'footer.project.issues', external: true },
  ];

  const docLinks = [
    { href: README_EN_URL, key: 'footer.docs.readmeEn', external: true },
    { href: README_ZH_URL, key: 'footer.docs.readmeZh', external: true },
    { href: LICENSE_URL, key: 'footer.docs.license', external: true },
  ];

  return (
    <footer className="border-t border-glass bg-glass backdrop-blur-xl">
      <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="grid gap-10 md:grid-cols-[1.5fr_1fr_1fr]">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <img src="/icon.png" alt="" className="h-8 w-8 rounded" />
              <span className="text-base font-semibold text-text-primary">App Audio Router</span>
            </div>
            <p className="mt-3 max-w-sm text-sm leading-relaxed text-text-secondary">
              {t('footer.tagline')}
            </p>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-flex items-center gap-2 rounded-full border border-glass px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
            >
              <GitHubIcon className="h-4 w-4" />
              Eververdants/AppAudioRouter
            </a>
          </div>

          <nav aria-label={t('footer.project.title')}>
            <h3 className="text-sm font-semibold text-text-primary">{t('footer.project.title')}</h3>
            <ul className="mt-3 space-y-2.5">
              {projectLinks.map((link) => (
                <li key={link.key}>
                  <a
                    href={link.href}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-block text-sm text-text-secondary transition-all duration-200 hover:translate-x-0.5 hover:text-accent"
                  >
                    {t(link.key)}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <nav aria-label={t('footer.docs.title')}>
            <h3 className="text-sm font-semibold text-text-primary">{t('footer.docs.title')}</h3>
            <ul className="mt-3 space-y-2.5">
              {docLinks.map((link) => (
                <li key={link.key}>
                  <a
                    href={link.href}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-block text-sm text-text-secondary transition-all duration-200 hover:translate-x-0.5 hover:text-accent"
                  >
                    {t(link.key)}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <div className="mt-10 border-t border-border pt-6">
          <p className="text-xs text-text-muted">{t('footer.meta', { version: VERSION })}</p>
          <p className="mt-1.5 text-xs text-text-muted">{t('footer.note', { version: VERSION })}</p>
        </div>
      </div>
    </footer>
  );
}
