// RealWorld static server: hashed assets immutable, HTML no-cache, gzip. With `embed`, a middleware
// fills each page's data placeholders (`<script type="application/json" data-sn>`, in document order)
// with the API's responses, so the page's first load makes no request.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { gzipSync } from 'node:zlib';
const [dir, port, mode] = process.argv.slice(2);
const API = 'http://localhost:4400';
const routes = [[/^\/(tag\/[^/]+)?$/, 'index'], [/^\/login$/, 'login'], [/^\/register$/, 'register'], [/^\/settings$/, 'settings'], [/^\/editor(\/[^/]+)?$/, 'editor'], [/^\/article\/([^/]+)$/, 'article'], [/^\/profile\/[^/]+(\/favorites)?$/, 'profile']];
// per page, the placeholders' requests, in document order (what the build would describe for the middleware)
const data = {
  index: (m, q) => [`/api/articles?${q.get('tag') ? `tag=${encodeURIComponent(q.get('tag'))}&` : ''}limit=10&offset=0`, '/api/tags'],
  article: (m) => [`/api/articles/${m[1]}`, `/api/articles/${m[1]}/comments`],
};
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  let path = u.pathname, hit = null;
  for (const [re, page] of routes) { const m = re.exec(path); if (m) { hit = [page, m]; path = `/${page}.html`; break; } }
  try {
    let body = await readFile(join(dir, path));
    if (mode == 'embed' && hit && data[hit[0]]) {
      const urls = data[hit[0]](hit[1], u.searchParams);
      const json = await Promise.all(urls.map((x) => fetch(API + x, { signal: AbortSignal.timeout(1000) }).then((r) => (r.ok ? r.text() : ''), () => '')));
      let i = 0;
      // `<` escaped, so the payload cannot close its script
      body = Buffer.from(String(body).replace(/(<script type="application\/json" data-sn="\d+">)(<\/script>)/g, (_, a, b) => a + (json[i++] ?? '').replace(/</g, '\\u003c') + b));
    }
    res.setHeader('Content-Type', types[extname(path)] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (/gzip/.test(req.headers['accept-encoding'] ?? '') && /^(text|application)/.test(res.getHeader('Content-Type'))) { res.setHeader('Content-Encoding', 'gzip'); res.end(gzipSync(body)); } else res.end(body);
  } catch { res.statusCode = 404; res.end(); }
}).listen(+port);
