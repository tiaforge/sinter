// Serves a build of the spike with its API, gzipped (bench/gzip.mjs), on Node's http server.
//   node server.mjs dist [port]          the data is fetched by the browser
//   node server.mjs dist-embed [port]    @tiaforge-ui/sinter/server writes it into the page (SINTER_EMBED=1 build)
// ?delay=<ms> on a page or API URL delays the API's response (measure.mjs: LCP over a slower API).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { embed } from '../../dist/server.js';
import { gzip } from '../gzip.mjs';
import { article, comments, tree } from './data.mjs';

const [dir = 'dist', port = '4390'] = process.argv.slice(2);
const root = resolve(import.meta.dirname, dir);
const BLOCKS = Number(process.env.BLOCKS ?? 300), COMMENTS = Number(process.env.COMMENTS ?? 50);
const bodies = { '/api/article': JSON.stringify({ id: 1, title: 'A long article', body: article(BLOCKS) }), '/api/comments': JSON.stringify(comments(COMMENTS)), '/api/tree': JSON.stringify(tree(article(BLOCKS))) };
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

async function app(req) {
  const u = new URL(req.url);
  if (bodies[u.pathname]) {
    const delay = Number(u.searchParams.get('delay') ?? 0);
    if (delay) await new Promise((r) => setTimeout(r, delay));
    return new Response(bodies[u.pathname], { headers: { 'content-type': 'application/json' } });
  }
  const path = normalize(decodeURIComponent(u.pathname));
  if (path.includes('..')) return new Response(null, { status: 400 });
  let file = join(root, path);
  try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html'); } catch { return new Response(null, { status: 404 }); }
  try {
    return new Response(await readFile(file), { headers: { 'content-type': types[extname(file)] ?? 'application/octet-stream' } });
  } catch { return new Response(null, { status: 404 }); }
}

let handler = app;
try {
  await stat(join(root, 'sinter-embed.json'));
  const sinter = await embed({ dir: root });
  handler = sinter.wrap(app);
} catch (e) { if (e.code !== 'ENOENT') throw e; }

createServer(async (req, res) => {
  const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers });
  const r = gzip(request, await handler(request));
  res.writeHead(r.status, Object.fromEntries(r.headers));
  if (r.body) Readable.fromWeb(r.body).pipe(res); else res.end();
}).listen(+port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port} (${dir}${handler === app ? '' : ', embedded data'})`));
