import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  // The webview parses and executes the entry chunk before the first paint, so
  // strip everything that only serves development from the production output.
  esbuild: {
    legalComments: 'none',
    drop: ['debugger'],
    // `console.warn` / `console.error` are kept on purpose so runtime failures
    // are still diagnosable in a release build.
    pure: ['console.log', 'console.debug', 'console.info', 'console.trace'],
  },
  build: {
    target: ['es2022', 'chrome100', 'safari13'],
    minify: 'esbuild',
    sourcemap: false,
    reportCompressedSize: false,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
      output: {
        // Splitting the vendors out keeps the entry chunk small and lets the
        // unchanged parts of the app stay cached across releases.
        manualChunks: {
          react: ['react', 'react-dom'],
          motion: ['framer-motion'],
          i18n: ['i18next', 'react-i18next'],
        },
      },
    },
    modulePreload: {
      // The webview is always a modern Chromium; the polyfill is dead weight.
      polyfill: false,
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
