// The live dashboard's server: the built variant pages (dist/<variant>/), the vendored libraries, and
// one SSE stream in three wire formats, at a rate the harness sets.
//   GET /events?fmt=json       `event: tick` with the tick as JSON (sinter, Solid, Svelte, Vue)
//   GET /events?fmt=datastar   `datastar-patch-signals`: the tick's changed values, formatted, as a JSON merge patch
//   GET /events?fmt=datastar-elements   `datastar-patch-elements`: the changed elements, morphed by id (two per tick)
//   GET /events?fmt=htmx       `event: tick`: the new seq for #seq plus the other changes out of band
//   GET /control?rate=N        ticks per second for every open stream (0 pauses); answers each stream's
//                              schedule: segments [first seq, its due time, ms per tick], so a client
//                              knows when every tick was due
// Ticks are scheduled on the clock: when the loop runs late it sends every tick that is due, each with
// the time it was due, so a server that falls behind shows up as latency like a browser that does.
//   node server.mjs [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { barsHtml, chartHtml, initial, rowHtml, seqHtml, signalPatch, slide, tick } from './shared/model.js';

const root = import.meta.dirname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
const now = () => performance.timeOrigin + performance.now();

let rate = 0;
const streams = new Set();
let sent = 0;

function encode(fmt, t, state) {
  if (fmt === 'json') return `event: tick\ndata: ${JSON.stringify(t)}\n\n`;
  // the hypermedia variants: the server keeps the view's state and renders what changed
  state.series = state.series.map((s, k) => slide(s, t.p[k]));
  state.bars = t.bars;
  const rows = t.hosts.map((h) => { const row = state.hosts[h.id]; row.v = h.v; row.d = h.d; return row; });
  if (fmt === 'datastar') return `event: datastar-patch-signals\ndata: signals ${JSON.stringify(signalPatch(state, t))}\n\n`;
  const parts = [...state.series.map((s, k) => chartHtml(k, s)), barsHtml(state.bars)];
  if (fmt === 'datastar-elements') {
    // the rows in an event of their own: Datastar parses an event's elements as one template's content,
    // where a <tr> after other elements is dropped. #seq last: when it changes, the rest of the tick is in.
    const ev = (els) => `event: datastar-patch-elements\n${els.map((p) => `data: elements ${p}\n`).join('')}\n`;
    return ev(rows.map(rowHtml)) + ev([...parts, seqHtml(t.seq)]);
  }
  // htmx swaps the out-of-band elements first, then the event's own target (#seq); rows go in a
  // <template> (htmx's way to swap table rows out of band)
  const oob = [...parts, ...rows.map(rowHtml)].map((p) => p.replace(/^<(\w+)/, '<$1 hx-swap-oob="true"'));
  return `event: tick\n${[String(t.seq), ...oob.slice(0, parts.length), `<template>${oob.slice(parts.length).join('')}</template>`].map((p) => `data: ${p}\n`).join('')}\n`;
}

function stream(req, res, fmt) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.socket.setNoDelay(true);
  res.write(': open\n\n');
  const s = { fmt, res, seq: 0, due: 0, state: initial(), segments: [] };
  streams.add(s);
  req.on('close', () => streams.delete(s));
}

// one loop for every stream: send each tick that is due, in one write per stream
let lastRate = 0;
function loop() {
  const t = performance.now();
  if (rate !== lastRate) { for (const s of streams) s.due = 0; lastRate = rate; }
  if (rate > 0) {
    const step = 1000 / rate;
    for (const s of streams) {
      if (!s.due) { s.due = t; s.segments.push([s.seq + 1, performance.timeOrigin + t, step]); }
      let out = '';
      while (s.due <= t) {
        const tk = tick(++s.seq, performance.timeOrigin + s.due);
        out += encode(s.fmt, tk, s.state);
        s.due += step;
        sent++;
      }
      if (out) s.res.write(out);
    }
  }
  setTimeout(loop, 1);
}
loop();

export function start(port = 0) {
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/events') return stream(req, res, u.searchParams.get('fmt') ?? 'json');
    if (u.pathname === '/control') {
      if (u.searchParams.has('rate')) rate = Math.max(0, Number(u.searchParams.get('rate')) || 0);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ rate, sent, now: now(), streams: [...streams].map((s) => ({ fmt: s.fmt, seq: s.seq, segments: s.segments })) }));
    }
    // /<variant>/ → dist/<variant>/index.html; /vendor/…, /shared/… from the bench directory
    let path = u.pathname.endsWith('/') ? u.pathname + 'index.html' : u.pathname;
    const base = /^\/(vendor|shared)\//.test(path) ? root : join(root, 'dist');
    const file = normalize(join(base, decodeURIComponent(path)));
    if (!file.startsWith(root + '/')) { res.writeHead(403); return res.end(); }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${server.address().port}`, close: () => { for (const s of streams) s.res.end(); server.closeAllConnections(); return new Promise((r) => server.close(r)); } })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await start(Number(process.argv[2] ?? 4500));
  console.log(`live dashboard: ${url}/<variant>/  (rate: ${url}/control?rate=100)`);
}
