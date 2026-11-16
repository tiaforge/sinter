// The demo backend, running inside Vite (`npm run dev` and `npm run preview`). It makes up its
// numbers: four times a second each running service takes a random step, and that one new sample is
// pushed to every open page as a server-sent event. Replace it with your own API.
//
//   GET    /api/openapi.yml    the API's description (server/openapi.yml), which the frontend is checked against
//   GET    /api/services       the services: { id, name, paused }
//   PATCH  /api/services/:id   { paused } → the service
//   GET    /api/samples        the last 30 seconds of samples: a ring, 121 slots per service
//   GET    /api/events         sample { slot, service, tick, at, status, rps, latencyMs, errorRate }, 4 times a second per
//                              running service: it replaces the oldest sample in the ring (its slot)
//                              service_updated { service }, when a service is paused or resumed
//   GET    /api/tone.wav       a made-up 8-second chord, for the player the layout keeps across pages

import { readFileSync } from 'node:fs';

const TICK_MS = 250;
/** 30 seconds of samples, and one more that the graphs keep just past their left edge */
const SLOTS = 121;

/** @returns {import('vite').Plugin} */
export default function api() {
  const spec = readFileSync(new URL('./openapi.yml', import.meta.url), 'utf8');
  /** @type {Set<import('node:http').ServerResponse>} */
  const streams = new Set();

  /** id → { id, name, paused } */
  const services = new Map();
  /** id → the walk's state: its base rate, where it is now, and the ticks a failing spell has left */
  const walks = new Map();
  /** slot → sample: the ring */
  const samples = new Map();
  let tick = 0;

  /** One step of a random walk around the base rate, with now and then a slow, failing spell. */
  const sample = (id, t, at) => {
    const w = walks.get(id);
    w.rps = Math.max(1, w.rps + (w.base - w.rps) * 0.05 + (Math.random() - 0.5) * w.base * 0.08);
    if (!w.spell && Math.random() < 0.004) w.spell = 16;
    const trouble = w.spell ? 1 : 0;
    if (w.spell) w.spell--;
    w.latencyMs = Math.max(10, w.latencyMs * 0.85 + (30 + Math.random() * 30 + trouble * 400) * 0.15);
    w.errorRate = Math.max(0, w.errorRate * 0.8 + (0.002 + trouble * 0.08) * 0.2);
    const latencyMs = Math.round(w.latencyMs), errorRate = Math.round(w.errorRate * 1000) / 1000;
    return {
      slot: `${id}:${((t % SLOTS) + SLOTS) % SLOTS}`, service: id, tick: t, at,
      status: errorRate > 0.05 ? 'down' : latencyMs > 150 ? 'degraded' : 'ok',
      rps: Math.round(w.rps), latencyMs, errorRate,
    };
  };

  for (const [id, name, base] of [['gateway', 'Gateway', 420], ['auth', 'Auth', 130], ['search', 'Search', 260], ['billing', 'Billing', 45]]) {
    services.set(id, { id, name, paused: false });
    walks.set(id, { base, rps: base, latencyMs: 40, errorRate: 0.002, spell: 0 });
    // the ring starts full, so the graphs have their 30 seconds at once
    for (let t = 1 - SLOTS; t <= 0; t++) {
      const s = sample(id, t, Date.now() + t * TICK_MS);
      samples.set(s.slot, s);
    }
  }

  const broadcast = (event, data) => {
    const text = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of streams) res.write(text);
  };

  // the player's sound, made here so the example has no binary file: 8 s of a soft chord, 16-bit mono at 16 kHz
  const tone = (() => {
    const rate = 16000, n = rate * 8, b = Buffer.alloc(44 + n * 2);
    b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
    b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) {
      const t = i / rate, v = [220, 277.18, 329.63].reduce((a, f) => a + Math.sin(2 * Math.PI * f * t), 0) / 3;
      b.writeInt16LE(Math.round(v * 6000 * (0.6 + 0.4 * Math.sin(Math.PI * t / 4))), 44 + i * 2);
    }
    return b;
  })();

  let timer;
  const step = () => {
    tick++;
    for (const s of services.values()) {
      if (s.paused) continue;
      const next = sample(s.id, tick, Date.now());
      samples.set(next.slot, next); // the oldest sample's slot
      broadcast('sample', next);
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
    if (url.pathname === '/api/tone.wav') {
      res.setHeader('content-type', 'audio/wav');
      return res.end(tone);
    }
    if (url.pathname === '/api/services' && req.method === 'GET') return send(200, [...services.values()]);
    if (url.pathname === '/api/samples' && req.method === 'GET') return send(200, [...samples.values()]);

    const one = url.pathname.match(/^\/api\/services\/([^/]+)$/);
    if (one && req.method === 'PATCH') {
      const service = services.get(one[1]);
      if (!service) return send(404, { message: 'No such service.' });
      await new Promise((r) => setTimeout(r, 400)); // so the optimistic change is visible
      let body = '';
      for await (const chunk of req) body += chunk;
      try { service.paused = !!JSON.parse(body).paused; } catch { return send(400, { message: 'The body is not JSON.' }); }
      broadcast('service_updated', { service });
      return send(200, service);
    }
    send(404, { message: 'Not found.' });
  };

  const start = (server) => {
    server.middlewares.use(handle);
    timer ??= setInterval(step, TICK_MS);
    server.httpServer?.on('close', () => clearInterval(timer));
  };
  return { name: 'dashboard-api', configureServer: start, configurePreviewServer: start };
}
