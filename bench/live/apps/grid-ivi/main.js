// ivi 5: immutable rows (the changed ones as new objects), a keyed List of Row components that skip
// unchanged rows (strictEq); updates batched by the default root (microtask).
import { createRoot, update, component, useState, html, List, strictEq } from 'ivi';
import { params, initialRows, byChange, fmtPrice, fmtPct, trend } from '../../shared/grid.js';

const q = params(location.search);
const Row = component(() => (r) => html`<div class="row"><span>${r.s}</span><span>${fmtPrice(r.p)}</span><span class=${trend(r.c)}>${fmtPct(r.c)}</span><span>${r.v}</span></div>`, strictEq);
const getKey = (r) => r.id;
const renderRow = (r) => Row(r);
const App = component((c) => {
  const [state, setState] = useState(c, { seq: 0, rows: initialRows(q.n) });
  new EventSource(`/events?fmt=grid&n=${q.n}&k=${q.k}`).addEventListener('tick', (e) => {
    const t = JSON.parse(e.data), rows = state().rows.slice();
    for (const r of t.rows) rows[r.id] = { ...rows[r.id], p: r.p, c: r.c, v: r.v };
    setState({ seq: t.seq, rows });
  });
  return () => {
    const { seq, rows } = state();
    return html`<header>seq <span id="seq">${seq}</span></header><div class="grid">${List(q.sort ? rows.slice().sort(byChange) : rows, getKey, renderRow)}</div>`;
  };
});
update(createRoot(document.getElementById('app')), App());
