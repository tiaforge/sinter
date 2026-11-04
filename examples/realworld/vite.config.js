import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import sinter from '@tiaforge/sinter/vite';

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
    sinter(),
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
