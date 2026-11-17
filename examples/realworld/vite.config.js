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
      // the article's body: <md-doc> renders the tree md.parse builds from its markdown (src/sinter.helpers.js)
      components: ['@tiaforge-ui/sinter-markdown'],
      // its parser loads as a chunk of its own (article.html preloads it with the page): with embedded data
      // (SINTER_EMBED), md.parse would otherwise run in the early script, the parser in front of the first paint
      lazy: ['@tiaforge-ui/sinter-markdown'],
      // links and navigate() swap the next page in: the e2e suite's settings tests keep reading the page
      // after saving (docs/navigation.md#swaps)
      swap: true,
      embed: !!process.env.SINTER_EMBED,
      // warnings fail the build, except SN529 for the tag list: the feed and the tag list sit in the RealWorld theme's
      // columns, which follow their content below 768 px. The build keeps the tag column hidden while the feed's first
      // rows load; the tags' own column is the row's last, so nothing follows it to move
      strict: { allow: { SN529: 'the shared RealWorld theme sizes .col-md-3 by its content below 768 px; nothing follows it in its row' } },
    }),
  ],
  // sinter-markdown is linked from packages/ (file:): its imports of sinter resolve to the app's
  resolve: { dedupe: ['@tiaforge-ui/sinter'] },
  build: {
    rollupOptions: { input: Object.fromEntries(pages.map((p) => [p, resolve(import.meta.dirname, `${p}.html`)])) },
  },
});
