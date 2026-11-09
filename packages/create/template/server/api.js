// A stand-in for your backend: an in-memory task list with a JSON API and a server-sent event
// stream, served by Vite in `npm run dev` and `npm run preview`. When your real API is up, remove
// `api()` from vite.config.js (and proxy /api to your server there, `server.proxy`).
//
//   GET    /api/tasks          all tasks
//   POST   /api/tasks          { title } → the new task
//   GET    /api/tasks/:id      one task
//   PATCH  /api/tasks/:id      { title?, notes?, done? } → the task
//   DELETE /api/tasks/:id
//   GET    /api/events         task_updated { task }, task_removed { id }
//   POST   /api/fail-next      the next change (POST, PATCH, DELETE) fails with a 503

/** Every request waits this long, so optimistic updates are visible. */
const LATENCY_MS = 300;

/** @returns {import('vite').Plugin} */
export default function api() {
  /** @type {Map<string, { id: string, title: string, notes: string, done: boolean, createdAt: string }>} */
  const tasks = new Map();
  /** @type {Set<import('node:http').ServerResponse>} */
  const streams = new Set();
  let failNext = false;
  let lastId = 0;

  const create = (title, done = false, minutesAgo = 0) => {
    const id = String(++lastId);
    const task = { id, title, notes: '', done, createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString() };
    tasks.set(id, task);
    return task;
  };
  create('Read the README', true, 90);
  create('Open this page in a second tab, then tick a task in one of them', false, 60);
  create('Press "Fail next change", then tick a task', false, 30);
  create('Open a task and give it some notes', false, 10);

  /** Sends one event to every open stream. */
  const broadcast = (event, data) => {
    for (const res of streams) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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

    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write(': connected\n\n');
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }

    await new Promise((r) => setTimeout(r, LATENCY_MS));
    const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJson(req);
    if (body === null) return send(400, { message: 'The request body is not JSON.' });

    if (req.method === 'POST' && url.pathname === '/api/fail-next') {
      failNext = true;
      return send(204);
    }
    if (req.method !== 'GET' && failNext) {
      failNext = false;
      return send(503, { message: 'The server refused this change, as you asked it to.' });
    }

    if (url.pathname === '/api/tasks') {
      if (req.method === 'GET') return send(200, [...tasks.values()]);
      if (req.method === 'POST') {
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        if (!title) return send(422, { message: 'A task needs a title.', errors: { title: 'A task needs a title.' } });
        const task = create(title);
        broadcast('task_updated', { task });
        return send(201, task);
      }
    }

    const id = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname)?.[1];
    const task = id ? tasks.get(id) : undefined;
    if (id && !task) return send(404, { message: 'There is no such task. Maybe someone deleted it.' });
    if (task) {
      if (req.method === 'GET') return send(200, task);
      if (req.method === 'PATCH') {
        if ('title' in body && (typeof body.title !== 'string' || !body.title.trim())) return send(422, { message: 'A task needs a title.', errors: { title: 'A task needs a title.' } });
        const changed = { ...task };
        if (typeof body.title === 'string') changed.title = body.title.trim();
        if (typeof body.notes === 'string') changed.notes = body.notes;
        if (typeof body.done === 'boolean') changed.done = body.done;
        tasks.set(task.id, changed);
        broadcast('task_updated', { task: changed });
        return send(200, changed);
      }
      if (req.method === 'DELETE') {
        tasks.delete(task.id);
        broadcast('task_removed', { id: task.id });
        return send(204);
      }
    }
    send(404, { message: `No route for ${req.method} ${url.pathname}.` });
  };

  /** @param {import('vite').ViteDevServer | import('vite').PreviewServer} server */
  const use = (server) => { server.middlewares.use(handle); };
  return { name: 'demo-api', configureServer: use, configurePreviewServer: use };
}

/** The parsed JSON body ({} when empty), or null when it is not JSON. */
async function readJson(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}
