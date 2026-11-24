// node snap.mjs <a.heapsnapshot> [b.heapsnapshot]: self size by (type, name) and, with two, the difference; top 40
import { readFileSync } from 'node:fs';
function sum(f) {
  const s = JSON.parse(readFileSync(f, 'utf8'));
  const m = s.snapshot.meta, nf = m.node_fields.length, types = m.node_types[0];
  const iT = m.node_fields.indexOf('type'), iN = m.node_fields.indexOf('name'), iS = m.node_fields.indexOf('self_size');
  const out = new Map(); const N = s.nodes;
  for (let i = 0; i < N.length; i += nf) {
    const t = types[N[i + iT]]; let name = t === 'string' || t === 'concatenated string' || t === 'sliced string' ? '' : s.strings[N[i + iN]];
    if (t === 'code' || t === 'hidden' || t==='array') name = name.slice(0, 40);
    if (t === 'closure') name = 'fn ' + name.slice(0, 40);
    const k = t + ' ' + name; const o = out.get(k) ?? out.set(k, [0, 0]).get(k); o[0]++; o[1] += N[i + iS];
  }
  return out;
}
const [a, b] = process.argv.slice(2).map(sum);
const keys = new Set([...a.keys(), ...(b?.keys() ?? [])]);
const rows = [...keys].map((k) => { const x = a.get(k) ?? [0, 0], y = b?.get(k) ?? [0, 0]; return { k, n: y[0] - (b ? x[0] : -x[0]) * (b ? 1 : 0) || (b ? y[0] - x[0] : x[0]), mb: b ? (y[1] - x[1]) / 1048576 : x[1] / 1048576 }; });
rows.sort((p, q) => q.mb - p.mb);
let tot = 0; for (const r of rows) tot += r.mb; console.log('total MB', tot.toFixed(1));
for (const r of rows.slice(0, +(process.env.TOP ?? 40))) console.log(r.mb.toFixed(2).padStart(8), String(r.n).padStart(8), r.k.slice(0, 90));
