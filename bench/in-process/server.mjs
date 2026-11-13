// RealWorld's build served by @tiaforge-ui/sinter/server with its API in the same app: a Hono app,
// wrapped, so each page's API requests are calls to `app.fetch` in-process. The API answers each route
// with recorded JSON (data/), as the axum and ASP.NET Core servers here do. run.sh makes the build's
// absolute API URLs same-origin paths.
//
//   npm run build (repository root); npm install (here)
//   node server.mjs <dist> [port] data      node:http, gzip flushed per chunk (the head goes out first)
//   bun server.mjs <dist> [port] data       Bun.serve, no compression
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { embed } from '../../dist/server.js';

const [dir, port = '4370', data = 'data'] = process.argv.slice(2);
const read = (f) => readFileSync(`${data}/${f}.json`);
const [articles, tags, article, comments, profile] = ['articles', 'tags', 'article', 'comments', 'profile'].map(read);
const json = { 'content-type': 'application/json' };

const app = new Hono();
app.get('/api/articles', (c) => c.body(articles, 200, json));
app.get('/api/tags', (c) => c.body(tags, 200, json));
app.get('/api/articles/:slug', (c) => c.body(article, 200, json));
app.get('/api/articles/:slug/comments', (c) => c.body(comments, 200, json));
app.get('/api/profiles/:username', (c) => c.body(profile, 200, json));

const sinter = await embed({ dir, data: { 'profile.html:articles': 'skip' } });
const handler = sinter.wrap(app.fetch);

if (globalThis.Bun) {
  Bun.serve({ port: +port, hostname: '127.0.0.1', fetch: handler });
  console.log(`http://127.0.0.1:${port}`);
} else {
  const { createServer } = await import('node:http');
  const zlib = await import('node:zlib');
  createServer(async (req, res) => {
    const ac = new AbortController();
    // the visitor went away before the response was out (`close` comes after a finished response too)
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    const out = await handler(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, signal: ac.signal }));
    const headers = Object.fromEntries(out.headers);
    const gzip = out.body && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '') && /^(text\/|application\/json)/.test(headers['content-type'] ?? '');
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
