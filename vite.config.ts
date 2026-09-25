import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // GitHub Pages project site of the main repository:
  // https://eververdants.github.io/AppAudioRouter/ — keep in sync with
  // SITE_URL in src/lib/site.ts. Local dev/preview then serves under the
  // same prefix (http://localhost:5173/AppAudioRouter/).
  base: '/AppAudioRouter/',
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: ['es2022', 'chrome100', 'safari13'],
    minify: 'esbuild',
    sourcemap: false,
    reportCompressedSize: false,
    rollupOptions: {
      output: {
        // Splitting the vendors out keeps the entry chunk small and lets the
        // unchanged parts of the page stay cached across releases.
        manualChunks: {
          react: ['react', 'react-dom'],
          motion: ['framer-motion'],
          i18n: ['i18next', 'react-i18next'],
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
