// RealWorld's build served by @tiaforge-ui/sinter/server with its API in the same app: a Hono app,
// wrapped, so each page's API requests are calls to `app.fetch` in-process. The API answers each route
// with recorded JSON (data/), as the axum and ASP.NET Core servers here do. run.sh makes the build's
// absolute API URLs same-origin paths.
//
//   npm run build (repository root); npm install (here)
//   node server.mjs <dist> [port] data      node:http
//   bun server.mjs <dist> [port] data       Bun.serve
// both with gzip flushed per chunk (bench/gzip.mjs: the head goes out first)
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { embed } from '../../dist/server.js';
import { gzip } from '../gzip.mjs';

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

// gzip as every layer here does: zlib level 6, flushed after each chunk the layer sends (bench/gzip.mjs)
const serve = async (req) => gzip(req, await handler(req));
if (globalThis.Bun) {
  Bun.serve({ port: +port, hostname: '127.0.0.1', fetch: serve });
  console.log(`http://127.0.0.1:${port}`);
} else {
  const { createServer } = await import('node:http');
  createServer(async (req, res) => {
    const ac = new AbortController();
    // the visitor went away before the response was out (`close` comes after a finished response too)
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    const out = await serve(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, signal: ac.signal }));
    res.writeHead(out.status, Object.fromEntries(out.headers));
    if (!out.body) return res.end();
    for await (const chunk of out.body) res.write(chunk);
    res.end();
  }).listen(+port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}`));
}
