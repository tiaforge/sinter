// The grid's helpers: the shared model, the page's query, and the step from one tick to the next.
import { params, initialRows, byChange, fmtPrice as fp, fmtPct as fc } from '../../../shared/grid.js';

const q = params(location.search);
export const size = () => q.n;
export const changes = () => q.k;
export const start = () => initialRows(q.n);
export const fmtPrice = (p) => fp(p);
export const fmtPct = (c) => fc(c);

/** The rows after a tick: a new array, the changed rows as new objects (the rest kept). */
export function merge(g, rows) {
  const next = g.slice();
  for (const r of rows) next[r.id] = { ...next[r.id], p: r.p, c: r.c, v: r.v };
  return next;
}

/** The rows in display order. */
export const view = (g) => (q.sort ? g.slice().sort(byChange) : g);
