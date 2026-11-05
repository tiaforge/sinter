// The backend for the transport e2e test: the built pages, the JSON API, a real SSE endpoint, a
// real WebSocket endpoint (the `ws` package) and a reverse proxy for /hubs/* (HTTP and WebSocket
// upgrades) to the ASP.NET Core SignalR hub, so the page sees one origin for everything.
//
// Control API for the runner (same for every transport, `t` = sse | ws | signalr):
//   POST /control/emit?t=…  {event, data}  apply to the store, then send it as a server event
//   POST /control/set       [people]       replace the store without an event (a missed change)
//   POST /control/drop?t=…                 cut every connection of that transport, as a network failure
//                                          would (signalr: the proxied sockets; the hub sends no close message)
//   POST /control/abort?t=signalr          the hub aborts its connections (a server-side close)
//   GET  /control/stats?t=…                {connected, total} connections, {probes} session probes;
//                                          signalr also {hubUpgrades}: WebSocket upgrades proxied to the hub
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const here = fileURLToPath(new URL('.', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' };

export async function start({ port = 0, hub }) {
  let people = [];
  let probes = 0;
  let hubUpgrades = 0; // SignalR WebSocket upgrades proxied (it falls back to SSE/long polling silently)
  const hubSockets = new Set(); // the browser side of each proxied hub WebSocket
  const sse = new Set();
  const stats = { sse: { total: 0 }, ws: { total: 0 } };
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (socket) => { stats.ws.total++; socket.on('error', () => {}); });

  const apply = (event, data) => {
    if (event === 'person_updated') people = [...people.filter((p) => p.id !== data.person.id), data.person];
    if (event === 'person_removed') people = people.filter((p) => p.id !== data.id);
  };
  const body = (req) => new Promise((ok) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => ok(b ? JSON.parse(b) : null)); });
  const json = (res, value, status = 200) => res.writeHead(status, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' }).end(JSON.stringify(value));
  const hubCall = async (path, init) => (await fetch(`${hub}${path}`, init)).json().catch(() => null);

  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const t = u.searchParams.get('t');
    try {
      if (u.pathname.startsWith('/hubs/')) return proxy(req, res);
      if (u.pathname === '/api/people') return json(res, people);
      if (u.pathname === '/api/user') { probes++; return json(res, { id: 'me' }); }
      if (u.pathname === '/sse/people') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        res.write(': open\n\n');
        sse.add(res);
        stats.sse.total++;
        req.on('close', () => sse.delete(res));
        return;
      }
      if (u.pathname === '/control/set') { people = await body(req); return json(res, people); }
      if (u.pathname === '/control/emit') {
        const { event, data } = await body(req);
        apply(event, data);
        if (t === 'sse') for (const r of sse) r.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        if (t === 'ws') for (const c of wss.clients) c.send(JSON.stringify({ event, data }));
        if (t === 'signalr') await hubCall('/control/emit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event, data }) });
        return json(res, { ok: true });
      }
      if (u.pathname === '/control/abort') { await hubCall('/control/drop', { method: 'POST' }); return json(res, { ok: true }); }
      if (u.pathname === '/control/drop') {
        if (t === 'sse') for (const r of sse) r.destroy();
        if (t === 'ws') for (const c of wss.clients) c.terminate();
        if (t === 'signalr') for (const s of hubSockets) s.destroy();
        return json(res, { ok: true });
      }
      if (u.pathname === '/control/stats') {
        const conn = t === 'sse' ? { connected: sse.size, total: stats.sse.total }
          : t === 'ws' ? { connected: wss.clients.size, total: stats.ws.total }
          : { ...await hubCall('/control/stats'), hubUpgrades };
        return json(res, { ...conn, probes });
      }
      const file = join(here, 'dist', normalize(u.pathname));
      if (!file.startsWith(join(here, 'dist'))) return res.writeHead(404).end();
      const data = await readFile(file).catch(() => null);
      if (!data) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }).end(data);
    } catch (e) {
      json(res, { error: String(e) }, 500);
    }
  });

  // /hubs/* over plain HTTP (negotiate, long polling) …
  const target = new URL(hub);
  function proxy(req, res) {
    const p = httpRequest({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    p.on('error', () => res.writeHead(502).end());
    req.pipe(p);
  }
  // … and WebSocket upgrades: /ws/* is ours, /hubs/* is piped to the hub byte for byte
  server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/ws/people') return wss.handleUpgrade(req, socket, head, (c) => wss.emit('connection', c, req));
    if (!path.startsWith('/hubs/')) return socket.destroy();
    hubUpgrades++;
    hubSockets.add(socket);
    socket.on('close', () => hubSockets.delete(socket));
    const upstream = connect(+target.port, target.hostname, () => {
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    const end = () => { upstream.destroy(); socket.destroy(); };
    upstream.on('error', end);
    socket.on('error', end);
    upstream.on('close', end);
    socket.on('close', end);
  });

  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((ok) => { for (const r of sse) r.destroy(); for (const c of wss.clients) c.terminate(); server.closeAllConnections(); server.close(ok); }),
  };
}
