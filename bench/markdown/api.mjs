// The spike's API as Vite middleware (dev and preview) and a plain handler (server.mjs).
import { article, comments } from './data.mjs';

const BLOCKS = Number(process.env.BLOCKS ?? 300);
const COMMENTS = Number(process.env.COMMENTS ?? 50);
const routes = {
  '/api/article': () => ({ id: 1, title: 'A long article', body: article(BLOCKS) }),
  '/api/comments': () => comments(COMMENTS),
};

export function handle(req, res, next) {
  const u = new URL(req.url, 'http://x');
  const r = routes[u.pathname];
  if (!r) return next();
  // ?blocks= and ?comments= override the size per request (measure.mjs)
  const body = u.pathname === '/api/article' && u.searchParams.has('blocks')
    ? { id: 1, title: 'A long article', body: article(Number(u.searchParams.get('blocks'))) }
    : r();
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

export const api = () => ({
  name: 'markdown-spike-api',
  configureServer: (s) => { s.middlewares.use(handle); },
  configurePreviewServer: (s) => { s.middlewares.use(handle); },
});
