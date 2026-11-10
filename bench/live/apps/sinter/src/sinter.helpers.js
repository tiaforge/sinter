// The dashboard's helpers: the shared model, and the step from one tick to the next.
import { SERIES, initial as start, linePath as path, fmt1 as f1, fmt2 as f2, slide } from '../../../shared/model.js';

export const initial = () => start();
export const seriesName = (k) => SERIES[k];
export const linePath = (arr) => path(arr);
export const fmt1 = (v) => f1(v);
export const fmt2 = (d) => f2(d);

/** The view after a tick: each window slid, the bars replaced, the changed hosts as new objects (the rest kept). */
export function advance(s, seq, p, bars, hosts) {
  const next = s.hosts.slice();
  for (const h of hosts) next[h.id] = { ...next[h.id], v: h.v, d: h.d };
  return { seq, series: s.series.map((sr, k) => slide(sr, p[k])), bars, hosts: next };
}
