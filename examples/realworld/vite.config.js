import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import sinter from '@tiaforge-ui/sinter/vite';

const pages = ['index', 'login', 'register', 'settings', 'editor', 'article', 'profile'];

/**
 * Which page serves which path. A multi-page app needs these rewrites on any server; here they
 * mirror the `data-sn-path` patterns of the pages, for `vite dev` and `vite preview`.
 */
const routes = [
  [/^\/(tag\/[^/]+)?$/, 'index'],
  [/^\/login$/, 'login'],
  [/^\/register$/, 'register'],
  [/^\/settings$/, 'settings'],
  [/^\/editor(\/[^/]+)?$/, 'editor'],
  [/^\/article\/[^/]+$/, 'article'],
  [/^\/profile\/[^/]+(\/favorites)?$/, 'profile'],
];

function rewrite(req, _res, next) {
  const [path, query = ''] = req.url.split('?');
  const page = routes.find(([re]) => re.test(path))?.[1];
  if (page) req.url = `/${page}.html${query ? '?' + query : ''}`;
  next();
}

export default defineConfig({
  appType: 'mpa',
  plugins: [
    // the API's origin: every page allows it (no configure({ origins }) needed), and its resources are requested before the page module
    // SINTER_EMBED=1: for a server that writes each page's data into it (packages/sinter-axum); the public
    // deployment is static, so off by default
    sinter({ openapi: 'openapi.yml', origins: ['https://api.realworld.show'], embed: !!process.env.SINTER_EMBED }),
    {
      name: 'conduit-routes',
      configureServer: (server) => () => server.middlewares.use(rewrite),
      configurePreviewServer: (server) => () => server.middlewares.use(rewrite),
    },
  ],
  build: {
    rollupOptions: { input: Object.fromEntries(pages.map((p) => [p, resolve(import.meta.dirname, `${p}.html`)])) },
  },
});
