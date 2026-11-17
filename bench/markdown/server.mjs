// Serves the build (dist/) with the API, gzipped (bench/gzip.mjs), on Node's http server.
//   node server.mjs [port]      /api/article: the markdown; /api/tree: the tree md.parse builds from it, in Node
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { rolldown } from 'rolldown';
import { gzip } from '../gzip.mjs';
import { article } from './data.mjs';

const root = resolve(import.meta.dirname, 'dist');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

/** md.parse in Node: the package's parse.ts bundled to a module (it is TypeScript, and imports sinter's memo) */
export async function nodeParse() {
  const pkg = resolve(import.meta.dirname, '../../packages/sinter-markdown/sinter');
  const b = await rolldown({ input: join(pkg, 'parse.ts'), platform: 'node', resolve: { alias: {
    '@tiaforge-ui/sinter-markdown/parser': join(pkg, 'parser.js'), '@tiaforge-ui/sinter/memo': resolve(import.meta.dirname, '../../dist/memo.js'),
  } } });
  const out = resolve(import.meta.dirname, 'node_modules/.parse.mjs');
  await b.write({ file: out, format: 'esm' });
  await b.close();
  return (await import(pathToFileURL(out).href)).parse;
}

export async function server(port = 0) {
  const parse = await nodeParse(), md = article();
  const bodies = { '/api/article': JSON.stringify({ id: 1, title: 'A long article', body: md }), '/api/tree': JSON.stringify(parse(md)) };
  async function app(req) {
    const u = new URL(req.url);
    if (bodies[u.pathname]) return new Response(bodies[u.pathname], { headers: { 'content-type': 'application/json' } });
    const path = normalize(decodeURIComponent(u.pathname));
    if (path.includes('..')) return new Response(null, { status: 400 });
    let file = join(root, path);
    try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html'); } catch { return new Response(null, { status: 404 }); }
    try { return new Response(await readFile(file), { headers: { 'content-type': types[extname(file)] ?? 'application/octet-stream' } }); }
    catch { return new Response(null, { status: 404 }); }
  }
  const s = createServer(async (req, res) => {
    const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers });
    const r = gzip(request, await app(request));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    if (r.body) Readable.fromWeb(r.body).pipe(res); else res.end();
  });
  await new Promise((ok) => s.listen(port, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${s.address().port}`, bodies, close: () => new Promise((ok) => { s.closeAllConnections(); s.close(ok); }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log((await server(Number(process.argv[2] ?? 4390))).url);
