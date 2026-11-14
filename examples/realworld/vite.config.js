import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';

const pages = ['index', 'login', 'register', 'settings', 'editor', 'article', 'profile'];

export default defineConfig({
  appType: 'mpa',
  plugins: [
    // the API: its base is the spec's server (https://api.realworld.show/api), so pages write paths
    // (`src="/articles"`) checked against the spec; its origin is allowed on every page, and its resources
    // are requested before the page module. What each endpoint returns is said once, here.
    // the pages' data-sn-path patterns are the routes: vite dev, vite preview, the build's _redirects and
    // sinter-axum serve /article/:slug from article.html, with nothing to write here
    // SINTER_EMBED=1: for a server that writes each page's data into it (packages/sinter-axum); the public
    // deployment is static, so off by default
    sinter({
      apis: {
        realworld: {
          openapi: 'openapi.yml',
          defaults: {
            'GET /user': { items: 'user' },
            'GET /articles': { items: 'articles', total: 'articlesCount', key: 'slug' },
            'GET /articles/feed': { items: 'articles', total: 'articlesCount', key: 'slug' },
            'GET /articles/{slug}': { items: 'article' },
            'GET /articles/{slug}/comments': { items: 'comments', key: 'id' },
            'GET /profiles/{username}': { items: 'profile' },
            'GET /tags': { items: 'tags' },
          },
        },
      },
      embed: !!process.env.SINTER_EMBED,
    }),
  ],
  build: {
    rollupOptions: { input: Object.fromEntries(pages.map((p) => [p, resolve(import.meta.dirname, `${p}.html`)])) },
  },
});
