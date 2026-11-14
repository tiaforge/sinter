const API = 'http://localhost:3001/api', app = document.getElementById('app');
const j = (r) => r.status === 204 ? null : r.json();
const req = (m, p, b) => fetch(API + p, { method: m, headers: { 'content-type': 'application/json' }, body: b && JSON.stringify(b) });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const m = location.pathname.match(/^\/incidents\/(\d+)/);

if (m) detail(m[1]); else list();

async function list() {
  let all = (await j(await fetch(API + '/incidents'))).incidents, q = '', err = '';
  const status = () => new URLSearchParams(location.search).get('status');
  app.innerHTML = `<h1>Incidents</h1>
    <form data-testid="create"><input name="title"><select name="severity"><option>low</option><option>medium</option><option>high</option></select><button>Report</button></form>
    <input data-testid="search"> <a data-testid="filter-all" href="/">All</a> <a data-testid="filter-open" href="?status=open">Open</a> <a data-testid="filter-resolved" href="?status=resolved">Resolved</a>
    <p data-testid="error" hidden></p><p data-testid="count"></p><ul></ul>`;
  const ul = app.querySelector('ul'), errEl = app.querySelector('[data-testid=error]');
  const render = () => {
    const shown = all.filter((i) => (!status() || i.status === status()) && i.title.toLowerCase().includes(q.toLowerCase()));
    app.querySelector('[data-testid=count]').textContent = `${shown.length} incidents`;
    errEl.hidden = !err; errEl.textContent = err;
    ul.innerHTML = shown.map((i) => `<li data-testid="incident" data-id="${i.id}"><a href="/incidents/${i.id}">${esc(i.title)}</a>
      <span data-testid="severity">${i.severity}</span> <span data-testid="status">${i.status}</span>
      <button data-testid="${i.status === 'open' ? 'resolve' : 'reopen'}">${i.status === 'open' ? 'Resolve' : 'Reopen'}</button>
      <button data-testid="delete">Delete</button></li>`).join('');
  };
  app.querySelector('[data-testid=search]').oninput = (e) => { q = e.target.value; render(); };
  app.querySelectorAll('[data-testid^=filter]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); history.pushState(null, '', a.getAttribute('href')); render(); }));
  onpopstate = render;
  app.querySelector('form').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target;
    const r = await req('POST', '/incidents', { title: f.title.value, severity: f.severity.value });
    const b = await j(r);
    if (r.ok) { all.unshift(b.incident); f.title.value = ''; err = ''; } else err = Object.entries(b.errors).map(([k, v]) => `${k} ${v.join(', ')}`).join('; ');
    render();
  };
  ul.onclick = async (e) => {
    const t = e.target.dataset.testid, li = e.target.closest('li'); if (!li) return;
    const i = all.find((x) => x.id == li.dataset.id);
    if (t === 'delete') { all = all.filter((x) => x !== i); render(); await req('DELETE', '/incidents/' + i.id); }
    if (t === 'resolve' || t === 'reopen') {
      const old = i.status; i.status = t === 'resolve' ? 'resolved' : 'open'; err = ''; render();
      const r = await req('PATCH', '/incidents/' + i.id, { status: i.status });
      if (!r.ok) { i.status = old; err = 'Could not change the status.'; render(); }
    }
  };
  render();
}

async function detail(id) {
  const r = await fetch(`${API}/incidents/${id}`);
  if (!r.ok) { app.innerHTML = '<p data-testid="not-found">Not found</p><a href="/">Back</a>'; return; }
  const i = (await r.json()).incident, comments = (await j(await fetch(`${API}/incidents/${id}/comments`))).comments;
  app.innerHTML = `<a href="/">Back</a><h1>${esc(i.title)}</h1><span data-testid="severity">${i.severity}</span> <span data-testid="status">${i.status}</span>
    <ul></ul><form data-testid="comment-form"><textarea name="body"></textarea><button>Comment</button></form>`;
  const ul = app.querySelector('ul'), render = () => (ul.innerHTML = comments.map((c) => `<li data-testid="comment">${esc(c.body)}</li>`).join(''));
  app.querySelector('form').onsubmit = async (e) => {
    e.preventDefault(); const r = await req('POST', `/incidents/${id}/comments`, { body: e.target.body.value });
    if (r.ok) { comments.push((await r.json()).comment); e.target.body.value = ''; render(); }
  };
  render();
}
