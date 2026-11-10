// The live grid's data, the same for every variant: N rows (symbol, price, change %, volume), and a
// stream of ticks that each change K rows. Every value is a pure function of (row, tick), so the
// server and the clients agree without sharing state.
//
// One tick (one SSE `tick` message): { seq, rows: [{ id, p, c, v }, …K] }
// Page query: ?n=10000&k=100&sort=1 (sort: the table stays sorted by change %, descending; ties by id)

export const params = (search) => {
  const q = new URLSearchParams(search);
  return { n: +(q.get('n') ?? 10000), k: +(q.get('k') ?? 100), sort: q.get('sort') === '1' };
};

function rnd(a, b = 0) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const symbol = (id) => LETTERS[id % 26] + LETTERS[Math.floor(id / 26) % 26] + LETTERS[Math.floor(id / 676) % 26] + (id >= 17576 ? Math.floor(id / 17576) : '');

/** The rows at tick 0. */
export function initialRows(n) {
  return Array.from({ length: n }, (_, id) => ({ id, s: symbol(id), p: Math.round(1000 + 99000 * rnd(id, 1)) / 100, c: Math.round(1000 * (rnd(id, 2) - 0.5)) / 100, v: Math.floor(1e6 * rnd(id, 3)) }));
}

/** The K rows tick `seq` changes (distinct ids), with their new price, change and volume. */
export function gridTick(seq, n, k) {
  const rows = [], start = Math.floor(rnd(seq, 7) * n), step = 7919 % n || 1;
  for (let j = 0; j < k; j++) {
    const id = (start + j * step) % n;
    rows.push({ id, p: Math.round(1000 + 99000 * rnd(seq, 10 + j)) / 100, c: Math.round(1000 * (rnd(seq, 20000 + j) - 0.5)) / 100, v: Math.floor(1e6 * rnd(seq, 40000 + j)) });
  }
  return rows;
}

/** Sort order: change descending, then id. */
export const byChange = (a, b) => b.c - a.c || a.id - b.id;

export const fmtPrice = (p) => p.toFixed(2);
export const fmtPct = (c) => (c > 0 ? '+' : '') + c.toFixed(2) + '%';
export const fmtVol = (v) => String(v);
export const trend = (c) => (c > 0 ? 'up' : c < 0 ? 'down' : '');

/** The rows after ticks 1…seq, in display order: for checking a page. */
export function expectedRows(n, k, sort, seq) {
  const rows = initialRows(n);
  for (let i = 1; i <= seq; i++) for (const r of gridTick(i, n, k)) Object.assign(rows[r.id], r);
  return sort ? rows.slice().sort(byChange) : rows;
}
