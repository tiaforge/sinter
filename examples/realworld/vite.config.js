import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';
import { apis } from './apis.js';

const pages = ['index', 'login', 'register', 'settings', 'editor', 'article', 'profile'];

export default defineConfig({
  appType: 'mpa',
  plugins: [
    // the API and what each endpoint returns: apis.js
    // the pages' data-sn-path patterns are the routes: vite dev, vite preview, the build's _redirects and
    // sinter-axum serve /article/:slug from article.html, with nothing to write here
    // SINTER_EMBED=1: for a server that writes each page's data into it (packages/sinter-axum); the public
    // deployment is static, so off by default
    sinter({
      apis,
      embed: !!process.env.SINTER_EMBED,
      // warnings fail the build
      strict: true,
    }),
  ],
  build: {
    // font files stay files: inlined (Vite's default below 4 KB), the small subsets of the text font would be in the
    // stylesheet every page waits for, for scripts most visitors never see
    assetsInlineLimit: 0,
    rollupOptions: { input: Object.fromEntries(pages.map((p) => [p, resolve(import.meta.dirname, `${p}.html`)])) },
  },
});
