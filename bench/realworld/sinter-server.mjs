// RealWorld's build (examples/realworld, built with SINTER_EMBED=1) served by @tiaforge-ui/sinter/server,
// as packages/sinter-axum/examples/realworld.rs serves it: every placeholder but one is described by the
// build, on an API origin allowed here; the profile's article list (a ternary the build cannot describe)
// comes from a resolver. Signed-out view: it is for measuring.
//
//   npm run build                                          (the package's dist/, at the repository root)
//   node sinter-server.mjs <dist> [port] [api origin]      node:http, gzip flushed per chunk (the head goes out first)
//   bun sinter-server.mjs <dist> [port] [api origin]       Bun.serve, the same handler, no compression
//   FETCH=undici node sinter-server.mjs …                    the API through undici.request() instead of fetch (docs/server.md#on-node)
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { embed } from '../../dist/server.js';

const [dir, port = '4370', api = 'http://localhost:4400'] = process.argv.slice(2);
if (!dir) { console.error('usage: sinter-server.mjs <dist> [port] [api origin]'); process.exit(1); }

// on Node, undici's request() behind a fetch-shaped function: the same client as fetch, without its WHATWG layer
let apiFetch = fetch;
if (process.env.FETCH == 'undici') {
  const { request } = await import('undici');
  apiFetch = async (url, init) => {
    const r = await request(url, { headers: init?.headers instanceof Headers ? Object.fromEntries(init.headers) : init?.headers, signal: init?.signal });
    return new Response(r.statusCode == 204 ? null : await r.body.arrayBuffer(), { status: r.statusCode, headers: r.headers });
  };
}

const sinter = await embed({
  dir,
  fetch: apiFetch,
  origins: [api],
  timeout: 800,
  data: {
    // ?author=… on the profile's own tab, ?favorited=… on its favorites
    'profile.html:articles': (r) => {
      const user = r.params.username;
      if (!user) return null;
      const by = r.params.tab == 'favorites' ? 'favorited' : 'author';
      const offset = (Math.max(1, parseInt(r.params.page ?? '', 10) || 1) - 1) * 10;
      return apiFetch(`${api}/api/articles?${by}=${encodeURIComponent(user)}&offset=${offset}&limit=10`, { signal: r.signal });
    },
  },
});

// the build's other files: hashed assets cached for good, everything else revalidated
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
async function files(req) {
  let path = normalize(decodeURIComponent(new URL(req.url).pathname));
  if (path.includes('..')) return new Response(null, { status: 400 });
  let file = join(dir, path);
  try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html'); } catch { return new Response(null, { status: 404 }); }
  try {
    return new Response(await readFile(file), { headers: { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' } });
  } catch { return new Response(null, { status: 404 }); }
}

const handler = sinter.wrap(files);

if (globalThis.Bun) {
  Bun.serve({ port: +port, hostname: '127.0.0.1', fetch: handler });
} else {
  const { createServer } = await import('node:http');
  const zlib = await import('node:zlib');
  const compress = /^(text\/|application\/(json|javascript)|image\/svg)/;
  createServer(async (req, res) => {
    const ac = new AbortController();
    // the visitor went away before the response was out (`close` comes after a finished response too)
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    const out = await handler(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, signal: ac.signal }));
    const headers = Object.fromEntries(out.headers);
    const gzip = out.body && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '') && compress.test(headers['content-type'] ?? '');
    if (gzip) { headers['content-encoding'] = 'gzip'; delete headers['content-length']; headers.vary = 'Accept-Encoding'; }
    res.writeHead(out.status, headers);
    if (!out.body) return res.end();
    // each chunk flushed, so the head reaches the browser before the data is in
    const sink = gzip ? zlib.createGzip({ flush: zlib.constants.Z_SYNC_FLUSH }) : res;
    if (gzip) sink.pipe(res);
    for await (const chunk of out.body) sink.write(chunk);
    sink.end();
  }).listen(+port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}`));
}
if (globalThis.Bun) console.log(`http://127.0.0.1:${port}`);
