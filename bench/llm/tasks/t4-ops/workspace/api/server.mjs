// Ops API for the T4 task. No dependencies: `node api/server.mjs` (PORT, default 3001).
// In-memory data, reset on restart (and by POST /__reset). CORS is open to any origin.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 3001);
const DELAY = Number(process.env.WRITE_DELAY_MS ?? 0); // a delay on every write, to simulate a slow network
const USERS = { alice: 'alice-pw', bob: 'bob-pw' };
const SEVERITY = { high: 3, medium: 2, low: 1 };

const TITLES = ['Checkout returns 502 for EU customers', 'Search results load slowly', 'Typo on the pricing page', '[locked] Database failover drill',
  'Password reset email delayed', 'CDN cache miss rate doubled', 'Mobile app crashes on login', 'Invoice PDF has wrong VAT', 'Webhook retries pile up',
  'Status page shows stale data', 'Disk usage alert on db-2', 'SSO login loops for Okta users', 'Export to CSV times out', 'Dark mode contrast too low',
  'Push notifications arrive twice', 'Rate limiter blocks partners', 'Search index out of date', 'Signup form rejects plus addresses',
  'Images fail to load in Safari', 'Nightly backup took 6 hours', 'Billing page shows old plan', 'Audit log missing entries', 'Map tiles render blank'];
const seed = () => {
  const sev = ['high', 'medium', 'low'];
  const incidents = TITLES.map((title, i) => ({
    id: i + 1, title, severity: sev[i % 3], status: i % 4 === 2 ? 'resolved' : 'open', version: 1,
    createdAt: new Date(Date.UTC(2026, 9, 1 + i, 9, 30)).toISOString(), updatedBy: i % 2 ? 'bob' : 'alice',
  }));
  return { incidents, nextId: incidents.length + 1, tokens: new Map() };
};
let db = seed();
const streams = new Set();

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type,authorization' };
const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', ...cors }); res.end(body === undefined ? '' : JSON.stringify(body)); };
const readBody = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { ok(null); } }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const broadcast = (type, data) => { for (const s of streams) s.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
const userOf = (req, url) => {
  const h = req.headers.authorization ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token');
  return token ? db.tokens.get(token) ?? null : null;
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname;
  if (req.method === 'OPTIONS') return send(res, 204);
  if (req.method !== 'GET') await sleep(DELAY);
  let m;
  if (p === '/__reset' && req.method === 'POST') { const tokens = db.tokens; db = seed(); db.tokens = tokens; broadcast('reset', {}); return send(res, 204); }

  if (p === '/api/login' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b || USERS[b.username] !== b.password) return send(res, 401, { error: 'Wrong username or password' });
    const token = randomUUID(); db.tokens.set(token, b.username);
    return send(res, 200, { token, user: { username: b.username } });
  }
  const user = userOf(req, url);
  if (p.startsWith('/api/') && !user) return send(res, 401, { error: 'Sign in first' });
  if (p === '/api/me') return send(res, 200, { user: { username: user } });
  if (p === '/api/logout' && req.method === 'POST') { for (const [t, u] of db.tokens) if (u === user) db.tokens.delete(t); return send(res, 204); }

  if (p === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...cors });
    res.write(': connected\n\n');
    streams.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => { clearInterval(ping); streams.delete(res); });
    return;
  }
  if (p === '/api/incidents' && req.method === 'GET') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase(), status = url.searchParams.get('status'), sort = url.searchParams.get('sort') ?? 'newest';
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1), per = Math.min(50, Math.max(1, Number(url.searchParams.get('per') ?? 10) || 10));
    let list = db.incidents.filter((i) => (!status || i.status === status) && (!q || i.title.toLowerCase().includes(q)));
    list.sort(sort === 'severity' ? (a, b) => SEVERITY[b.severity] - SEVERITY[a.severity] || b.id - a.id : (a, b) => b.id - a.id);
    const total = list.length;
    return send(res, 200, { incidents: list.slice((page - 1) * per, page * per), total, page, pages: Math.max(1, Math.ceil(total / per)) });
  }
  if (p === '/api/incidents' && req.method === 'POST') {
    const b = await readBody(req), errors = {};
    const title = typeof b?.title === 'string' ? b.title.trim() : '';
    if (!title) errors.title = ['is required']; else if (title.length > 80) errors.title = ['must be at most 80 characters'];
    if (!SEVERITY[b?.severity]) errors.severity = ['must be one of low, medium, high'];
    if (Object.keys(errors).length) return send(res, 422, { errors });
    const incident = { id: db.nextId++, title, severity: b.severity, status: 'open', version: 1, createdAt: new Date().toISOString(), updatedBy: user };
    db.incidents.push(incident); broadcast('incident.created', { incident });
    return send(res, 201, { incident });
  }
  if ((m = p.match(/^\/api\/incidents\/(\d+)$/))) {
    const id = Number(m[1]), incident = db.incidents.find((i) => i.id === id);
    if (!incident) return send(res, 404, { error: 'not found' });
    if (req.method === 'GET') return send(res, 200, { incident });
    if (req.method === 'PATCH') {
      const b = await readBody(req);
      if (incident.title.startsWith('[locked]')) return send(res, 500, { error: 'incident is locked' });
      if (b?.version !== incident.version) return send(res, 409, { error: 'Someone else changed this incident', incident });
      const errors = {};
      if ('status' in b && b.status !== 'open' && b.status !== 'resolved') errors.status = ['must be open or resolved'];
      if ('title' in b && (typeof b.title !== 'string' || !b.title.trim() || b.title.trim().length > 80)) errors.title = ['must be 1 to 80 characters'];
      if (Object.keys(errors).length) return send(res, 422, { errors });
      if ('status' in b) incident.status = b.status;
      if ('title' in b) incident.title = b.title.trim();
      incident.version++; incident.updatedBy = user;
      broadcast('incident.updated', { incident });
      return send(res, 200, { incident });
    }
    if (req.method === 'DELETE') {
      db.incidents = db.incidents.filter((i) => i.id !== id); broadcast('incident.deleted', { id });
      return send(res, 204);
    }
  }
  send(res, 404, { error: 'not found' });
}).listen(PORT, () => console.log(`ops API on http://localhost:${PORT}`));
