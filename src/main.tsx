import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
