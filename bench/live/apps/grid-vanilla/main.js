// Plain JS, the floor: changes buffered and applied once per frame; only changed cells written;
// in sorted mode, the rows of the longest increasing subsequence (old positions in the new order) stay,
// the others are moved: the fewest moves.
import { params, initialRows, byChange, fmtPrice, fmtPct, trend } from '../../shared/grid.js';

const q = params(location.search);
// write-order experiments (?exp=): order (changed rows in DOM order), column (one column at a time),
// detach (the container out of the document while writing)
const exp = new URLSearchParams(location.search).get('exp');
const rows = initialRows(q.n), tbody = document.getElementById('rows'), seqEl = document.getElementById('seq');
const tpl = document.createElement('div');
tpl.className = 'row';
tpl.innerHTML = '<span></span><span></span><span></span><span></span>';
const els = rows.map((r) => {
  const tr = tpl.cloneNode(true), [s, p, c, v] = tr.children;
  s.textContent = r.s; p.textContent = fmtPrice(r.p); c.textContent = fmtPct(r.c); c.className = trend(r.c); v.textContent = r.v;
  return tr;
});
let order = q.sort ? rows.slice().sort(byChange) : rows;
tbody.append(...order.map((r) => els[r.id]));

const dirty = new Set();
let seq = 0, queued = false;
new EventSource(`/events?fmt=grid&n=${q.n}&k=${q.k}`).addEventListener('tick', (e) => {
  const t = JSON.parse(e.data);
  for (const r of t.rows) { Object.assign(rows[r.id], r); dirty.add(r.id); }
  seq = t.seq;
  if (!queued) { queued = true; requestAnimationFrame(render); }
});
function render() {
  queued = false;
  for (const id of dirty) {
    const r = rows[id], [, p, c, v] = els[id].children;
    p.textContent = fmtPrice(r.p); c.textContent = fmtPct(r.c); c.className = trend(r.c); v.textContent = r.v;
  }
  dirty.clear();
  if (q.sort) {
    const next = rows.slice().sort(byChange), was = new Int32Array(q.n);
    order.forEach((r, i) => { was[r.id] = i; });
    const keep = lis(next.map((r) => was[r.id]));
    // from the end: each row not kept goes before the row after it
    for (let i = next.length - 1, after = null, j = keep.length - 1; i >= 0; i--) {
      const tr = els[next[i].id];
      if (j >= 0 && keep[j] === i) j--; else tbody.insertBefore(tr, after);
      after = tr;
    }
    order = next;
  }
  seqEl.textContent = seq;
}

/** Indexes (into `a`) of a longest increasing subsequence of `a`. */
function lis(a) {
  const prev = new Int32Array(a.length), tails = [];
  for (let i = 0; i < a.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (a[tails[m]] < a[i]) lo = m + 1; else hi = m; }
    prev[i] = lo ? tails[lo - 1] : -1;
    tails[lo] = i;
  }
  const out = new Array(tails.length);
  for (let i = tails.length - 1, k = tails[tails.length - 1]; i >= 0; i--, k = prev[k]) out[i] = k;
  return out;
}
