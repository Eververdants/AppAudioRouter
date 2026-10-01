import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'framer-motion';
import '@/i18n';
import { installProductionGuards } from '@/lib/productionGuards';
import App from './App';
import './styles/index.css';
import { useRouterStore } from '@/stores/routerStore';

// Release builds only: suppress the browser context menu and inspector shortcuts.
installProductionGuards();

if (import.meta.env.DEV) {
  // Debug handle for `vite dev`: seed state from the devtools console to
  // preview the UI without the Tauri backend. Stripped from production builds.
  (window as unknown as Record<string, unknown>).__routerStore = useRouterStore;
}

// `reducedMotion="user"` follows the OS setting: transforms and layout
// animations drop out, while the opacity changes that carry state still play.
const rootElement = document.getElementById('root');
if (rootElement === null) {
  // Nothing to attach to: say so instead of throwing a bare TypeError. The
  // only way here is a broken index.html, which no amount of UI can cover.
  console.error('[boot] #root element is missing; nothing to render into');
} else {
  createRoot(rootElement).render(
    <StrictMode>
      <MotionConfig reducedMotion="user">
        <App />
      </MotionConfig>
    </StrictMode>,
  );
}
