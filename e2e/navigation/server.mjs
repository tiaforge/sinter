// The backend for the navigation e2e test: the built pages (with the app's rewrites: `/` and
// `/item/:id`), and a JSON API on the same origin, so the browser needs no request interception
// (which turns prerendering off). Every request is logged with its `Sec-Purpose` header. Pages go
// out as a strict deployment would send them: `Content-Security-Policy: script-src 'self'` and the
// `Speculation-Rules` header for the build's rules file, served as application/speculationrules+json.
//
// Control API for the runner:
//   POST /control/delay?ms=…   later API answers wait that long
//   GET  /control/log          [{path, purpose, at}] every page and API request so far
//   POST /control/reset        clears the log and the delay
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const ITEMS = [1, 2, 3].map((id) => ({ id, title: `Item ${id}` }));

export async function start({ port = 0 } = {}) {
  let delay = 0, log = [], answers = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'), path = url.pathname;
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (path.startsWith('/control/')) {
      if (path === '/control/delay') { delay = +url.searchParams.get('ms'); return json(200, { delay }); }
      if (path === '/control/log') return json(200, log);
      if (path === '/control/reset') { delay = 0; log = []; return json(200, {}); }
      return json(404, {});
    }
    log.push({ path: req.url, purpose: req.headers['sec-purpose'] ?? null, at: Date.now() });
    if (path.startsWith('/api/')) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (path === '/api/items') return json(200, { items: ITEMS });
      const m = /^\/api\/items\/(\d+)$/.exec(path), item = m && ITEMS.find((i) => i.id === +m[1]);
      // a new title on every answer: the runner tells a prefetched one from a fresh one
      return item ? json(200, { item: { ...item, title: `${item.title} (answer ${++answers})` } }) : json(404, { message: 'not found' });
    }
    if (path === '/speculation-rules.json') {
      const rules = await readFile(join(here, 'dist', 'speculation-rules.json')).catch(() => null);
      if (!rules) return json(404, {});
      res.writeHead(200, { 'Content-Type': 'application/speculationrules+json' });
      return res.end(rules);
    }
    const page = path === '/' ? 'index.html' : /^\/item\/\d+$/.test(path) ? 'item.html' : null;
    const file = normalize(join(here, 'dist', page ?? path));
    if (!file.startsWith(join(here, 'dist'))) return json(403, {});
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': page ? 'no-cache' : 'max-age=3600',
        ...(page ? { 'Content-Security-Policy': "script-src 'self'", 'Speculation-Rules': '"/speculation-rules.json"' } : {}),
      });
      res.end(body);
    } catch { json(404, {}); }
  });
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  const { port: p } = server.address();
  return { url: `http://127.0.0.1:${p}`, close: () => new Promise((ok) => server.close(ok)) };
}
