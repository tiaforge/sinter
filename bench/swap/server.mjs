// Serves the variant pages and the row responses. Responses are built once per URL and kept in
// memory, so the server's own time is the same small constant for every variant.
//   node server.mjs [port]    browse http://localhost:<port>/htmx-4.0.1.html?n=1000&s=replace
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rows } from './pages/rows.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };
const scenario = (s) => (['update', 'append'].includes(s) ? s : 'replace');
const esc = (s) => String(s).replace(/[&<>]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt' }[c]};`);
const trs = (rs) => rs.map((r) => `<tr><td class="id">${r.id}</td><td class="label">${esc(r.label)}</td></tr>`).join('');

/** The response for one data URL, or null. Query: n (rows), s (scenario), v (set a, b, or c: appended rows). */
function data(path, q) {
  const n = Math.min(+q.get('n') || 0, 100_000), s = scenario(q.get('s'));
  // sinter's append page asks with paginate parameters: direction=next is the added rows
  const v = q.get('v') === 'b' ? 'b' : q.get('v') === 'c' || q.get('direction') === 'next' ? 'c' : 'a';
  if (path === '/rows.html') return { type: TYPES['.html'], body: trs(rows(n, s, v)) };
  if (path === '/rows.json') return { type: TYPES['.json'], body: JSON.stringify({ rows: rows(n, s, v) }) };
  // Datastar: an element with the target's id is morphed into place (its default); with mode=replace
  // the response names the selector and mode in headers and the element is replaced without morphing.
  // Appending: the new rows with mode append.
  if (path === '/rows-ds.html' && s === 'append' && v === 'c') return {
    type: TYPES['.html'], body: trs(rows(n, s, v)), headers: { 'datastar-selector': '#target', 'datastar-mode': 'append' },
  };
  if (path === '/rows-ds.html') return {
    type: TYPES['.html'], body: `<tbody id="target">${trs(rows(n, s, v))}</tbody>`,
    headers: q.get('mode') === 'replace' ? { 'datastar-selector': '#target', 'datastar-mode': 'replace' } : {},
  };
  return null;
}

const cache = new Map();
async function respond(url) {
  const u = new URL(url, 'http://x');
  const d = data(u.pathname, u.searchParams);
  if (d) return d;
  let file;
  if (u.pathname.startsWith('/vendor/')) file = join(here, normalize(u.pathname));
  else if (u.pathname.startsWith('/sinter/')) file = join(here, 'dist', normalize(u.pathname.slice('/sinter'.length)).replace(/\/$/, '/index.html'));
  else file = join(here, 'pages', normalize(u.pathname));
  if (!file.startsWith(here)) return null;
  let body = await readFile(file).catch(() => null);
  if (body == null) return null;
  const type = TYPES[extname(file)] ?? 'application/octet-stream';
  if (type.startsWith('text/html')) { // fill the page's {{n}} / {{s}}
    const n = String(+u.searchParams.get('n') || 0), s = scenario(u.searchParams.get('s'));
    body = body.toString().replaceAll('{{n}}', n).replaceAll('{{s}}', s);
  }
  return { type, body };
}

export function start(port = 0) {
  const server = createServer(async (req, res) => {
    let r = cache.get(req.url);
    if (!r) { r = await respond(req.url); if (r) cache.set(req.url, r); }
    if (!r) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': r.type, 'Cache-Control': 'no-store', ...r.headers });
    res.end(r.body);
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({
    url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((c) => server.close(c)),
    data,
  })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = await start(+(process.argv[2] ?? 8040));
  console.log(s.url);
}
