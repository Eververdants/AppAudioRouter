import { useEffect, useState, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import appIcon from '@/assets/app-icon.png';
import {
  closeWindow,
  isWindowMaximized,
  minimizeWindow,
  onWindowResized,
  toggleMaximizeWindow,
} from '@/lib/window';

/** Bar height in px, kept in sync with the `h-9` class on the header. */
const BAR_HEIGHT = 36;

// Tracks the most recent resize-listener effect run so a StrictMode
// double-mount cannot orphan the first subscription.
let activeResizeToken: unknown = null;

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
 * handle (`data-tauri-drag-region`), it draws the minimize / maximize / close
 * buttons, and it toggles between the router view and the settings page.
 * Interactive children must not carry the drag attribute, otherwise they would
 * stop receiving clicks.
 */
export function TitleBar({
  settingsOpen,
  onToggleSettings,
}: {
  settingsOpen: boolean;
  onToggleSettings: () => void;
}) {
  const { t } = useTranslation();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    // Token-based subscription so a StrictMode double-mount cannot orphan the
    // first resize listener (see the same pattern in App.tsx).
    const token = {};
    activeResizeToken = token;
    let unlisten: (() => void) | null = null;

    const refresh = () => {
      void isWindowMaximized().then(setMaximized);
    };

    void onWindowResized(refresh).then((off) => {
      if (activeResizeToken !== token) off();
      else unlisten = off;
    });
    refresh();

    return () => {
      if (activeResizeToken === token) activeResizeToken = null;
      unlisten?.();
    };
  }, []);

  return (
    <header
      // The native caption is disabled, so this custom bar is the window frame.
      // `role="toolbar"` groups the controls for AT; the brand stays a plain
      // labelled region. `data-tauri-drag-region` makes the empty space a drag
      // handle — interactive children must not carry it or they stop clicking.
      role="toolbar"
      aria-label={t('productName')}
      data-tauri-drag-region
      style={{ height: BAR_HEIGHT }}
      className="relative z-20 flex flex-none select-none items-stretch justify-between border-b border-glass bg-glass backdrop-blur-xl"
    >
      {/* Brand. `pointer-events-none` keeps the whole area draggable instead of
          swallowing the press on the text. */}
      <div className="pointer-events-none flex min-w-0 items-center gap-2.5 pl-3.5">
        <img src={appIcon} alt="" className="h-4 w-4 rounded" />
        <span className="truncate text-xs font-semibold text-text-primary">App Audio Router</span>
        <span className="rounded bg-accent-muted px-1.5 py-px text-[10px] font-medium leading-4 text-accent">
          v2.1
        </span>
      </div>

      <div className="flex items-center gap-2">
        <motion.button
          type="button"
          onClick={onToggleSettings}
          aria-label={t('settings.title')}
          title={t('settings.title')}
          aria-pressed={settingsOpen}
          whileHover={{ rotate: 30, scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
          transition={{ type: 'spring', stiffness: 400, damping: 20 }}
          className={`mr-1 flex h-7 w-7 items-center justify-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60 ${
            settingsOpen
              ? 'bg-accent-muted text-accent'
              : 'text-text-secondary hover:bg-bg-tertiary hover:text-accent'
          }`}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </motion.button>

        <div className="flex h-full items-stretch">
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
