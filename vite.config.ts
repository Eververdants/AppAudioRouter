import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Trees under the project root that are not this app's source.
 *
 * Vite watches the whole root, and two of the things in it belong to somebody
 * else: `promo/` is a nested project with its own `node_modules` and a Python
 * build that writes `.tmpdir` directories while it runs, and `.mimosa/` is
 * local tooling state. Watching them costs a crawl through a second dependency
 * tree for no reload anyone wants — and on Windows it can end the session. A
 * file another process still holds open answers `fs.watch` with EBUSY, and a
 * temp file under a tree being written to is exactly that.
 */
const IGNORED_TREES = ['**/src-tauri/**', '**/promo/**', '**/.mimosa/**'];

/**
 * Keep a refused `fs.watch` from ending the session.
 *
 * chokidar emits `error` for a watch it could not establish, and Node treats an
 * unhandled `error` event as fatal: one locked file — an antivirus scan, a
 * synced folder, a tool writing temp files under the root — used to kill
 * `tauri dev` with a stack trace that says nothing about the app and no hint
 * about which tree did it. Nothing here can make the handle appear; what this
 * can do is name the tree that went quiet and keep serving the rest, where
 * losing hot reload for one directory costs a refresh instead of the session.
 */
function tolerateWatcherErrors(): Plugin {
  return {
    name: 'aar:tolerate-watcher-errors',
    configureServer(server) {
      // The same path can refuse on every retry, and one warning per refusal
      // would bury the first one — which is the only one with news in it.
      const reported = new Set<string>();
      server.watcher.on('error', (error: Error) => {
        const { code, path } = error as NodeJS.ErrnoException;
        const key = `${code ?? 'error'}:${path ?? error.message}`;
        if (reported.has(key)) return;
        reported.add(key);
        server.config.logger.warn(
          `[watch] ${code ?? 'error'}${path === undefined ? '' : ` at ${path}`} — ` +
            'this tree is no longer watched; the rest of the app still reloads.',
        );
      });
    },
  };
}

// The version the window shows. Read from package.json rather than from
// `npm_package_version`, which is only set when the build is launched through a
// package-manager script: running vite directly — which is how the E2E suite
// and the screenshot capture start it — would otherwise stamp `v0.0.0` on the
// title bar and in the README images.
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as {
  version: string;
};

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tolerateWatcherErrors()],
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: IGNORED_TREES,
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
