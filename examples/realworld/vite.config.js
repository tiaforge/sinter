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
      // warnings fail the build, except SN529: the feed and the tag list sit in the RealWorld theme's
      // columns, which follow their content below 768 px, and the shared theme stays as it is
      strict: { allow: { SN529: 'the shared RealWorld theme sizes .col-md-9 and .col-md-3 by their content below 768 px; it is not ours to change' } },
    }),
  ],
  build: {
    rollupOptions: { input: Object.fromEntries(pages.map((p) => [p, resolve(import.meta.dirname, `${p}.html`)])) },
  },
});
