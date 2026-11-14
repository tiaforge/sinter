const API = window.API, app = document.getElementById('app');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
let token = localStorage.getItem('token'), me = localStorage.getItem('me');
const signOut = (next) => { localStorage.removeItem('token'); token = null; location.href = '/login' + (next ? '?next=' + encodeURIComponent(next) : ''); };
async function req(method, path, body) {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) });
  if (r.status === 401) { signOut(location.pathname + location.search); throw new Error('401'); }
  return r;
}
const events = () => new EventSource(`${API}/events?token=${token}`);
const header = () => `<header><span data-testid="user">${esc(me)}</span> <button data-testid="logout">Sign out</button> <a href="/">Board</a></header>`;
const wireHeader = () => (app.querySelector('[data-testid=logout]').onclick = async () => { await req('POST', '/logout').catch(() => {}); signOut(); });

const path = location.pathname;
if (path === '/login') login();
else if (!token) signOut(path + location.search);
else if (path.startsWith('/incidents/')) detail(path.split('/')[2]);
else boardPage();

function login() {
  app.innerHTML = `<form data-testid="login"><input name="username"><input name="password" type="password"><button>Sign in</button><p data-testid="error"></p></form>`;
  app.querySelector('form').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target;
    const r = await fetch(API + '/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: f.username.value, password: f.password.value }) });
    const b = await r.json();
    if (!r.ok) { app.querySelector('[data-testid=error]').textContent = b.error; return; }
    localStorage.setItem('token', b.token); localStorage.setItem('me', b.user.username);
    location.href = new URLSearchParams(location.search).get('next') || '/';
  };
}

function boardPage() {
  const state = () => { const p = new URLSearchParams(location.search); return { page: +(p.get('page') ?? 1), q: p.get('q') ?? '', status: p.get('status') ?? '', sort: p.get('sort') ?? 'newest' }; };
  const toUrl = (s) => { const p = new URLSearchParams(); if (s.page > 1) p.set('page', s.page); if (s.q) p.set('q', s.q); if (s.status) p.set('status', s.status); if (s.sort !== 'newest') p.set('sort', s.sort); const q = p.toString(); return '/' + (q ? '?' + q : ''); };
  const go = (patch, reset = true) => { const s = { ...state(), ...patch }; if (reset) s.page = 1; history.pushState(null, '', toUrl(s)); load(); };
  let data = { incidents: [], page: 1, pages: 1 }, err = '', conflict = '', editing = null, pending = new Map();
  app.innerHTML = `${header()}<form data-testid="create"><input name="title"><select name="severity"><option>low</option><option>medium</option><option>high</option></select><button>Report</button></form>
    <input data-testid="search"> <select data-testid="status-filter"><option value="">all</option><option>open</option><option>resolved</option></select>
    <select data-testid="sort"><option>newest</option><option>severity</option></select>
    <p data-testid="error"></p><p data-testid="conflict"></p><div id="undo"></div><ul></ul><button data-testid="prev">Prev</button> <span data-testid="page"></span> <button data-testid="next">Next</button>`;
  wireHeader();
  const $ = (s) => app.querySelector(s), ul = $('ul');
  const render = () => {
    $('[data-testid=error]').textContent = err; $('[data-testid=conflict]').textContent = conflict;
    $('[data-testid=page]').textContent = `Page ${data.page} of ${data.pages}`;
    $('[data-testid=prev]').disabled = data.page <= 1; $('[data-testid=next]').disabled = data.page >= data.pages;
    ul.innerHTML = data.incidents.filter((i) => !pending.has(i.id)).map((i) => `<li data-testid="incident" data-id="${i.id}">
      ${editing === i.id ? `<input name="title" value="${esc(i.title)}">` : `<a data-testid="title" href="/incidents/${i.id}">${esc(i.title)}</a>`}
      <span data-testid="severity">${i.severity}</span> <span data-testid="status">${i.status}</span>
      <button data-testid="${i.status === 'open' ? 'resolve' : 'reopen'}">${i.status === 'open' ? 'Resolve' : 'Reopen'}</button>
      <button data-testid="edit">Rename</button> <button data-testid="delete">Delete</button></li>`).join('');
    const input = ul.querySelector('input[name=title]'); if (input) input.focus();
    $('#undo').innerHTML = pending.size ? `<button data-testid="undo">Undo delete</button>` : '';
  };
  async function load() {
    const s = state();
    $('[data-testid=search]').value = s.q; $('[data-testid=status-filter]').value = s.status; $('[data-testid=sort]').value = s.sort;
    const p = new URLSearchParams({ page: s.page, sort: s.sort }); if (s.q) p.set('q', s.q); if (s.status) p.set('status', s.status);
    data = await (await req('GET', '/incidents?' + p)).json(); render();
  }
  let t; $('[data-testid=search]').oninput = (e) => { clearTimeout(t); t = setTimeout(() => go({ q: e.target.value }), 300); };
  $('[data-testid=status-filter]').onchange = (e) => go({ status: e.target.value });
  $('[data-testid=sort]').onchange = (e) => go({ sort: e.target.value });
  $('[data-testid=prev]').onclick = () => go({ page: state().page - 1 }, false);
  $('[data-testid=next]').onclick = () => go({ page: state().page + 1 }, false);
  onpopstate = load;
  $('[data-testid=create]').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target;
    const r = await req('POST', '/incidents', { title: f.title.value, severity: f.severity.value }); const b = await r.json();
    if (r.ok) { f.title.value = ''; err = ''; if (!data.incidents.some((i) => i.id === b.incident.id)) data.incidents.unshift(b.incident); }
    else err = Object.entries(b.errors).map(([k, v]) => `${k} ${v.join(', ')}`).join('; ');
    render();
  };
  const find = (id) => data.incidents.find((i) => i.id === id);
  ul.onclick = async (e) => {
    const t = e.target.dataset.testid, li = e.target.closest('li'); if (!li || !t) return;
    const i = find(+li.dataset.id);
    if (t === 'resolve' || t === 'reopen') {
      const old = i.status; i.status = t === 'resolve' ? 'resolved' : 'open'; err = ''; render();
      const r = await req('PATCH', `/incidents/${i.id}`, { version: i.version, status: i.status });
      if (r.ok) Object.assign(i, (await r.json()).incident); else { i.status = old; err = 'The status change failed.'; } render();
    }
    if (t === 'edit') { editing = i.id; render(); }
    if (t === 'delete') {
      const timer = setTimeout(async () => { pending.delete(i.id); data.incidents = data.incidents.filter((x) => x !== i); await req('DELETE', `/incidents/${i.id}`); render(); }, 5000);
      pending.set(i.id, timer); render();
    }
  };
  $('#undo').onclick = () => { for (const t of pending.values()) clearTimeout(t); pending.clear(); render(); };
  ul.onkeydown = async (e) => {
    if (e.target.name !== 'title') return;
    const i = find(editing);
    if (e.key === 'Escape') { editing = null; render(); }
    if (e.key !== 'Enter') return;
    const old = i.title; i.title = e.target.value; editing = null; conflict = ''; render();
    const r = await req('PATCH', `/incidents/${i.id}`, { version: i.version, title: i.title }); const b = await r.json();
    if (r.ok) Object.assign(i, b.incident);
    else if (r.status === 409) { Object.assign(i, b.incident); conflict = `${b.incident.updatedBy} changed this incident first.`; }
    else { i.title = old; err = 'Rename failed.'; }
    render();
  };
  const es = events();
  es.addEventListener('incident.created', (e) => { const { incident } = JSON.parse(e.data); const s = state(); if (s.page === 1 && !s.q && !s.status && s.sort === 'newest' && !find(incident.id)) { data.incidents.unshift(incident); data.incidents = data.incidents.slice(0, 10); render(); } });
  es.addEventListener('incident.updated', (e) => { const { incident } = JSON.parse(e.data); const i = find(incident.id); if (i) { Object.assign(i, incident); render(); } });
  es.addEventListener('incident.deleted', (e) => { const { id } = JSON.parse(e.data); data.incidents = data.incidents.filter((i) => i.id !== id); render(); });
  load();
}

async function detail(id) {
  const show = (i) => {
    app.innerHTML = header() + (i ? `<h1>${esc(i.title)}</h1><span data-testid="severity">${i.severity}</span> <span data-testid="status">${i.status}</span> <span data-testid="updated-by">${esc(i.updatedBy)}</span>` : '<p data-testid="not-found">Not found</p>') + '<a href="/">Back</a>';
    wireHeader();
  };
  const r = await req('GET', `/incidents/${id}`);
  show(r.ok ? (await r.json()).incident : null);
  const es = events();
  es.addEventListener('incident.updated', (e) => { const { incident } = JSON.parse(e.data); if (incident.id == id) show(incident); });
  es.addEventListener('incident.deleted', (e) => { if (JSON.parse(e.data).id == id) show(null); });
}
