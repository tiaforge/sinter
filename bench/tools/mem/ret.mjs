// node ret.mjs <snap> <type> [name] [k]: the k largest nodes of that type/name and a retainer chain for each (and the totals by first retainer edge)
import { readFileSync } from 'node:fs';
const [f, T, NAME, K = '6'] = process.argv.slice(2);
const s = JSON.parse(readFileSync(f, 'utf8'));
const m = s.snapshot.meta, nf = m.node_fields.length, ef = m.edge_fields.length, types = m.node_types[0], etypes = m.edge_types[0];
const iT = m.node_fields.indexOf('type'), iN = m.node_fields.indexOf('name'), iS = m.node_fields.indexOf('self_size'), iE = m.node_fields.indexOf('edge_count');
const eT = m.edge_fields.indexOf('type'), eN = m.edge_fields.indexOf('name_or_index'), eTo = m.edge_fields.indexOf('to_node');
const N = s.nodes, E = s.edges, cnt = N.length / nf;
const first = new Uint32Array(cnt + 1); for (let i = 0, e = 0; i < cnt; i++) { first[i] = e; e += N[i * nf + iE] * ef; } first[cnt] = E.length;
const rev = Array.from({ length: cnt }, () => []);
for (let i = 0; i < cnt; i++) for (let e = first[i]; e < first[i + 1]; e += ef) { const et = etypes[E[e + eT]]; if (et === 'weak') continue; rev[E[e + eTo] / nf].push([i, e]); }
const tn = (i) => types[N[i * nf + iT]]; const nm = (i) => { const t = tn(i); const x = s.strings[N[i * nf + iN]]; return t.includes('string') ? JSON.stringify(x.slice(0, 60)) : x.slice(0, 60); };
const en = (e) => { const et = etypes[E[e + eT]]; return et === 'element' || et === 'hidden' ? `[${E[e + eN]}]` : s.strings[E[e + eN]]; };
const hasEdges = (i, names) => { const got = new Set(); for (let e = first[i]; e < first[i + 1]; e += ef) if (etypes[E[e + eT]] === 'property') got.add(s.strings[E[e + eN]]); return names.every((x) => got.has(x)); };
const PROPS = process.env.PROPS?.split(',');
const sel = []; for (let i = 0; i < cnt; i++) if (tn(i) === T && (!PROPS || hasEdges(i, PROPS)) && (NAME === undefined || NAME === '*' || s.strings[N[i * nf + iN]] === NAME)) sel.push(i);
if (process.env.EDGE) { const want = process.env.EDGE; for (let j = sel.length - 1; j >= 0; j--) { const i = sel[j]; const r = rev[i].find(([p]) => tn(p) !== 'synthetic') ?? rev[i][0]; if (!r || en(r[1]) !== want) sel.splice(j, 1); } }
sel.sort((a, b) => N[b * nf + iS] - N[a * nf + iS]);
const byEdge = new Map();
for (const i of sel) { const r = rev[i].find(([p]) => tn(p) !== 'synthetic') ?? rev[i][0]; const k = r ? `${tn(r[0])}:${nm(r[0])}.${en(r[1])}` : 'none'; byEdge.set(k, (byEdge.get(k) ?? 0) + N[i * nf + iS]); }
console.log('selected', sel.length, 'MB', (sel.reduce((a, i) => a + N[i * nf + iS], 0) / 1048576).toFixed(2));
for (const [k, v] of [...byEdge].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log((v / 1048576).toFixed(2).padStart(7), k);
for (const i of sel.slice(0, +K)) {
  let c = i, path = [`${tn(c)} ${nm(c)} (${N[c * nf + iS]} B)`]; const seen = new Set([c]);
  for (let d = 0; d < 14; d++) { const r = rev[c].filter(([p]) => !seen.has(p) && tn(p) !== 'synthetic').sort((a, b) => (tn(a[0]) === 'hidden') - (tn(b[0]) === 'hidden'))[0]; if (!r) break; c = r[0]; seen.add(c); path.push(`<-${en(r[1])}- ${tn(c)} ${nm(c)}`); }
  console.log(path.join('\n   '));
}
if (process.env.GROUP) {
  const g = new Map(); const D = +process.env.GROUP;
  for (const i of sel) { let c = i, sig = []; const seen = new Set([c]);
    for (let d = 0; d < D; d++) { const r = rev[c].filter(([p]) => !seen.has(p) && tn(p) !== 'synthetic').sort((a, b) => (tn(a[0]) === 'hidden') - (tn(b[0]) === 'hidden'))[0]; if (!r) break; c = r[0]; seen.add(c); const e = en(r[1]); sig.push(`${/^\[?\d+\]?$/.test(e) ? '#' : e}<${tn(c)} ${nm(c).slice(0, 30)}`); }
    const k = sig.join(' | '); const o = g.get(k) ?? g.set(k, [0, 0]).get(k); o[0]++; o[1] += N[i * nf + iS]; }
  console.log('--- grouped'); for (const [k, [n, b]] of [...g].sort((a, b) => b[1][1] - a[1][1]).slice(0, 25)) console.log((b / 1048576).toFixed(2).padStart(7), String(n).padStart(6), k);
}
