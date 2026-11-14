// Incident API for the T1 task. No dependencies: `node api/server.mjs` (PORT, default 3001).
// In-memory data, reset on restart (and by POST /__reset). CORS is open, so a page on any port can call it.
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 3001);
const DELAY = Number(process.env.WRITE_DELAY_MS ?? 0); // a delay on every write, to simulate a slow network

const seed = () => {
  const t = (d) => new Date(Date.UTC(2026, 9, d, 9, 30)).toISOString();
  const incidents = [
    { id: 1, title: 'Checkout returns 502 for EU customers', severity: 'high', status: 'open', createdAt: t(1) },
    { id: 2, title: 'Search results load slowly', severity: 'medium', status: 'open', createdAt: t(2) },
    { id: 3, title: 'Typo on the pricing page', severity: 'low', status: 'resolved', createdAt: t(3) },
    { id: 4, title: '[locked] Database failover drill', severity: 'high', status: 'open', createdAt: t(4) },
    { id: 5, title: 'Password reset email delayed', severity: 'medium', status: 'resolved', createdAt: t(5) },
  ];
  const comments = [
    { id: 1, incidentId: 1, body: 'Rolled back the gateway config.', createdAt: t(1) },
    { id: 2, incidentId: 1, body: 'Still seeing errors in Frankfurt.', createdAt: t(2) },
  ];
  return { incidents, comments, nextId: 6, nextComment: 3 };
};
let db = seed();

const send = (res, status, body) => {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const readBody = (req) => new Promise((ok) => {
  let s = '';
  req.on('data', (c) => (s += c));
  req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { ok(null); } });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SEVERITIES = ['low', 'medium', 'high'];

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'OPTIONS') return send(res, 204);
  if (req.method !== 'GET') await sleep(DELAY);
  let m;

  if (p === '/__reset' && req.method === 'POST') { db = seed(); return send(res, 204); }

  if (p === '/api/incidents' && req.method === 'GET') {
    let list = [...db.incidents].sort((a, b) => b.id - a.id);
    const status = url.searchParams.get('status');
    if (status) list = list.filter((i) => i.status === status);
    return send(res, 200, { incidents: list });
  }
  if (p === '/api/incidents' && req.method === 'POST') {
    const b = await readBody(req);
    const errors = {};
    const title = typeof b?.title === 'string' ? b.title.trim() : '';
    if (!title) errors.title = ['is required'];
    else if (title.length > 80) errors.title = ['must be at most 80 characters'];
    if (!SEVERITIES.includes(b?.severity)) errors.severity = ['must be one of low, medium, high'];
    if (Object.keys(errors).length) return send(res, 422, { errors });
    const incident = { id: db.nextId++, title, severity: b.severity, status: 'open', createdAt: new Date().toISOString() };
    db.incidents.push(incident);
    return send(res, 201, { incident });
  }
  if ((m = p.match(/^\/api\/incidents\/(\d+)$/))) {
    const id = Number(m[1]);
    const incident = db.incidents.find((i) => i.id === id);
    if (!incident) return send(res, 404, { error: 'not found' });
    if (req.method === 'GET') return send(res, 200, { incident });
    if (req.method === 'PATCH') {
      const b = await readBody(req);
      if (incident.title.startsWith('[locked]')) return send(res, 500, { error: 'incident is locked' });
      if (b?.status !== 'open' && b?.status !== 'resolved') return send(res, 422, { errors: { status: ['must be open or resolved'] } });
      incident.status = b.status;
      return send(res, 200, { incident });
    }
    if (req.method === 'DELETE') {
      db.incidents = db.incidents.filter((i) => i.id !== id);
      db.comments = db.comments.filter((c) => c.incidentId !== id);
      return send(res, 204);
    }
  }
  if ((m = p.match(/^\/api\/incidents\/(\d+)\/comments$/))) {
    const id = Number(m[1]);
    if (!db.incidents.some((i) => i.id === id)) return send(res, 404, { error: 'not found' });
    if (req.method === 'GET') return send(res, 200, { comments: db.comments.filter((c) => c.incidentId === id) });
    if (req.method === 'POST') {
      const b = await readBody(req);
      const body = typeof b?.body === 'string' ? b.body.trim() : '';
      if (!body) return send(res, 422, { errors: { body: ['is required'] } });
      const comment = { id: db.nextComment++, incidentId: id, body, createdAt: new Date().toISOString() };
      db.comments.push(comment);
      return send(res, 201, { comment });
    }
  }
  send(res, 404, { error: 'not found' });
}).listen(PORT, () => console.log(`incident API on http://localhost:${PORT}`));
