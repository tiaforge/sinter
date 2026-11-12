// The demo backend, running inside Vite (`npm run dev` and `npm run preview`). It makes up its
// numbers: every second each running service takes a random step and the new state is pushed to
// every open page as a server-sent event. Replace it with your own API.
//
//   GET    /api/openapi.yml    the API's description (server/openapi.yml), which the frontend is checked against
//   GET    /api/services       all services
//   PATCH  /api/services/:id   { paused } → the service
//   GET    /api/events         service_updated { service }, once a second per running service

import { readFileSync } from 'node:fs';

const SAMPLES = 30;

/** @returns {import('vite').Plugin} */
export default function api() {
  const spec = readFileSync(new URL('./openapi.yml', import.meta.url), 'utf8');
  /** @type {Set<import('node:http').ServerResponse>} */
  const streams = new Set();

  const make = (id, name, base) => {
    const service = { id, name, status: 'ok', paused: false, rps: base, latencyMs: 40, errorRate: 0.002, history: [] };
    for (let i = 0; i < SAMPLES; i++) step(service, base);
    return service;
  };
  /** A random walk around `base`, with now and then a slow, failing spell. */
  const step = (s, base) => {
    const rps = Math.max(1, s.rps + (base - s.rps) * 0.1 + (Math.random() - 0.5) * base * 0.2);
    const trouble = Math.random() < 0.04 ? 1 : 0;
    s.rps = Math.round(rps);
    s.latencyMs = Math.round(Math.max(10, s.latencyMs * 0.7 + (30 + Math.random() * 30 + trouble * 400) * 0.3));
    s.errorRate = Math.round(Math.max(0, s.errorRate * 0.6 + (0.002 + trouble * 0.08) * 0.4) * 1000) / 1000;
    s.status = s.errorRate > 0.05 ? 'down' : s.latencyMs > 150 ? 'degraded' : 'ok';
    s.history = [...s.history.slice(-(SAMPLES - 1)), s.rps];
  };

  const bases = new Map();
  const services = new Map();
  for (const [id, name, base] of [['gateway', 'Gateway', 420], ['auth', 'Auth', 130], ['search', 'Search', 260], ['billing', 'Billing', 45]]) {
    bases.set(id, base);
    services.set(id, make(id, name, base));
  }

  let timer;
  const tick = () => {
    for (const s of services.values()) {
      if (s.paused) continue;
      step(s, bases.get(s.id));
      for (const res of streams) res.write(`event: service_updated\ndata: ${JSON.stringify({ service: s })}\n\n`);
    }
  };

  /** @type {import('vite').Connect.NextHandleFunction} */
  const handle = async (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return next();
    const send = (status, body) => {
      res.statusCode = status;
      if (body === undefined) return res.end();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/api/openapi.yml') {
      res.setHeader('content-type', 'application/yaml');
      return res.end(spec);
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write(': connected\n\n');
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    if (url.pathname === '/api/services' && req.method === 'GET') return send(200, [...services.values()]);

    const one = url.pathname.match(/^\/api\/services\/([^/]+)$/);
    if (one && req.method === 'PATCH') {
      const service = services.get(one[1]);
      if (!service) return send(404, { message: 'No such service.' });
      await new Promise((r) => setTimeout(r, 400)); // so the optimistic change is visible
      let body = '';
      for await (const chunk of req) body += chunk;
      try { Object.assign(service, { paused: !!JSON.parse(body).paused }); } catch { return send(400, { message: 'The body is not JSON.' }); }
      const event = `event: service_updated\ndata: ${JSON.stringify({ service })}\n\n`;
      for (const r of streams) r.write(event);
      return send(200, service);
    }
    send(404, { message: 'Not found.' });
  };

  return {
    name: 'dashboard-api',
    configureServer(server) { server.middlewares.use(handle); timer ??= setInterval(tick, 1000); server.httpServer?.on('close', () => clearInterval(timer)); },
    configurePreviewServer(server) { server.middlewares.use(handle); timer ??= setInterval(tick, 1000); server.httpServer?.on('close', () => clearInterval(timer)); },
  };
}
