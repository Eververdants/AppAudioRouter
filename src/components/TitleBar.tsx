import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import appIcon from '@/assets/app-icon.png';
import { LanguageToggle } from '@/components/LanguageToggle';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useTheme } from '@/hooks/useTheme';
import { useRouterStore } from '@/stores/routerStore';
import {
  closeWindow,
  isWindowMaximized,
  minimizeWindow,
  onWindowResized,
  toggleMaximizeWindow,
} from '@/lib/window';

/** Bar height in px, kept in sync with the `h-9` class on the header. */
const BAR_HEIGHT = 36;

/** Window control button, sized like the Windows 11 caption buttons. */
function WindowControl({
  label,
  onClick,
  danger = false,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex h-full w-[46px] items-center justify-center transition-colors ${
        danger
          ? 'text-text-secondary hover:bg-[#e81123] hover:text-white active:bg-[#c50f1f]'
          : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary active:bg-border'
      }`}
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 10 10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        aria-hidden="true"
      >
        {children}
      </svg>
    </button>
  );
}

/**
 * Custom title bar replacing the native one.
 *
 * The window is frameless, so this bar owns the whole caption: it is the drag
 * handle (`data-tauri-drag-region`), it hosts the app-level controls that used
 * to live in the in-app header, and it draws the minimize / maximize / close
 * buttons. Interactive children must not carry the drag attribute, otherwise
 * they would stop receiving clicks.
 */
export function TitleBar() {
  const { t } = useTranslation();
  const { theme, toggle } = useTheme();
  const autoRemember = useRouterStore((s) => s.autoRemember);
  const toggleAutoRemember = useRouterStore((s) => s.toggleAutoRemember);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;

    const refresh = () => {
      void isWindowMaximized().then(setMaximized);
    };

    void onWindowResized(refresh).then((off) => {
      if (disposed) off();
      else unlisten = off;
    });
    refresh();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return (
    <header
      data-tauri-drag-region
      style={{ height: BAR_HEIGHT }}
      className="flex flex-none select-none items-stretch justify-between border-b border-border bg-bg-secondary"
    >
      {/* Brand. `pointer-events-none` keeps the whole area draggable instead of
          swallowing the press on the text. */}
      <div className="pointer-events-none flex min-w-0 items-center gap-2.5 pl-3.5">
        <img src={appIcon} alt="" className="h-4 w-4 rounded" />
        <span className="truncate text-xs font-semibold text-text-primary">App Audio Router</span>
        <span className="rounded bg-accent-muted px-1.5 py-px text-[10px] font-medium leading-4 text-accent">
          v2.0
        </span>
      </div>

      <div className="flex items-center gap-2">
        {/* Auto-remember lives here so it stays reachable when the log panel is
            hidden on narrow windows. */}
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-text-muted">
          <input
            type="checkbox"
            checked={autoRemember}
            onChange={toggleAutoRemember}
            className="h-3.5 w-3.5 rounded border-border accent-accent"
          />
          {t('header.autoRemember')}
        </label>

        <LanguageToggle />
        <ThemeToggle theme={theme} onToggle={toggle} />

        <div className="ml-1 flex h-full items-stretch">
          <WindowControl label={t('titleBar.minimize')} onClick={() => void minimizeWindow()}>
            <line x1="0" y1="5" x2="10" y2="5" />
          </WindowControl>

          <WindowControl
            label={maximized ? t('titleBar.restore') : t('titleBar.maximize')}
            onClick={() => void toggleMaximizeWindow()}
          >
            {maximized ? (
              <>
                <rect x="0.5" y="2.5" width="7" height="7" />
                <path d="M2.5 2.5V0.5h7v7h-2" />
              </>
            ) : (
              <rect x="0.5" y="0.5" width="9" height="9" />
            )}
          </WindowControl>

          <WindowControl label={t('titleBar.close')} onClick={() => void closeWindow()} danger>
            <line x1="0.5" y1="0.5" x2="9.5" y2="9.5" />
            <line x1="9.5" y1="0.5" x2="0.5" y2="9.5" />
          </WindowControl>
        </div>
      </div>
    </header>
  );
}
