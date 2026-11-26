// Serves the production build of examples/realworld the way the other implementations' demo hosts
// serve theirs: the page for each path (the app's `data-sn-path` patterns, as in its vite.config.js),
// brotli for text, immutable caching for hashed assets. HTTP/1.1; the demos' CDNs speak HTTP/2.
//   node serve.mjs [port]      (build first: npm run build --prefix examples/realworld)
//   h2: true serves HTTP/2 over TLS with a throwaway self-signed cert (clients must ignore cert errors)
//   REALWORLD_DIST=dist-x …    serves another build of the app (A/B: one outDir per variant)
import { createServer } from 'node:http';
import { createSecureServer } from 'node:http2';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync } from 'node:zlib';

const app = resolve(import.meta.dirname, '../../examples/realworld');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
const TEXT = new Set(['.html', '.js', '.css', '.json', '.svg']);
const ROUTES = [
  [/^\/(tag\/[^/]+)?$/, 'index'],
  [/^\/login$/, 'login'],
  [/^\/register$/, 'register'],
  [/^\/settings$/, 'settings'],
  [/^\/editor(\/[^/]+)?$/, 'editor'],
  [/^\/article\/[^/]+$/, 'article'],
  [/^\/profile\/[^/]+(\/favorites)?$/, 'profile'],
];

/** `dist`: the build to serve, relative to examples/realworld (default `REALWORLD_DIST`, else `dist`) */
export async function serve({ port = 0, host = '127.0.0.1', h2 = false, dist: out = process.env.REALWORLD_DIST ?? 'dist' } = {}) {
  const dist = resolve(app, out);
  const cache = new Map();
  const handler = async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const page = ROUTES.find(([re]) => re.test(path))?.[1];
    const file = normalize(join(dist, page ? `${page}.html` : decodeURIComponent(path)));
    if (!file.startsWith(dist + '/')) { res.writeHead(403); return res.end(); }
    const ext = extname(file);
    const br = TEXT.has(ext) && /\bbr\b/.test(req.headers['accept-encoding'] ?? '');
    let body = cache.get(file + br);
    if (!body) {
      try { body = await readFile(file); } catch { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      if (br) body = brotliCompressSync(body);
      cache.set(file + br, body);
    }
    res.writeHead(200, {
      'Content-Type': TYPES[ext] ?? 'application/octet-stream',
      'Cache-Control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...(br ? { 'Content-Encoding': 'br', Vary: 'Accept-Encoding' } : {}),
    });
    res.end(body);
  };
  let server;
  if (h2) {
    const dir = mkdtempSync(join(tmpdir(), 'sinter-h2-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=localhost', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' });
    server = createSecureServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')), allowHTTP1: true }, handler);
  } else server = createServer(handler);
  await new Promise((ok) => server.listen(port, host, ok));
  return { url: `http${h2 ? 's' : ''}://${host}:${server.address().port}`, close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(ok); server.closeAllConnections?.(); }) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await serve({ port: Number(process.argv[2] ?? 4173) });
  console.log(`RealWorld (sinter): ${url}`);
}
