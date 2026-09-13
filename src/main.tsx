import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/i18n';
import App from './App';
import './styles/index.css';
import { useRouterStore } from '@/stores/routerStore';

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
