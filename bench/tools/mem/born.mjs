// node born.mjs <a> <b>: objects in b not in a (born, alive at b) and in a not in b (died), by type/name and first retainer (in b / in a)
import { readFileSync } from 'node:fs';
function load(f) {
  const s = JSON.parse(readFileSync(f, 'utf8')); const m = s.snapshot.meta, nf = m.node_fields.length, ef = m.edge_fields.length;
  const iT = m.node_fields.indexOf('type'), iN = m.node_fields.indexOf('name'), iS = m.node_fields.indexOf('self_size'), iI = m.node_fields.indexOf('id'), iE = m.node_fields.indexOf('edge_count');
  const eT = m.edge_fields.indexOf('type'), eN = m.edge_fields.indexOf('name_or_index'), eTo = m.edge_fields.indexOf('to_node');
  const N = s.nodes, E = s.edges, cnt = N.length / nf, types = m.node_types[0], etypes = m.edge_types[0];
  const ids = new Map(); for (let i = 0; i < cnt; i++) ids.set(N[i * nf + iI], i);
  const first = new Uint32Array(cnt + 1); for (let i = 0, e = 0; i < cnt; i++) { first[i] = e; e += N[i * nf + iE] * ef; } first[cnt] = E.length;
  const ret = new Int32Array(cnt).fill(-1), rete = new Int32Array(cnt).fill(-1);
  for (let i = 0, e = 0; i < cnt; i++) { const ec = N[i * nf + iE]; for (let k = 0; k < ec; k++, e += ef) { const to = E[e + eTo] / nf; const et = etypes[E[e + eT]]; if (et === 'weak' || types[N[i * nf + iT]] === 'synthetic') continue; if (ret[to] < 0 || types[N[ret[to] * nf + iT]] === 'hidden') { ret[to] = i; rete[to] = e; } } }
  const tn = (i) => types[N[i * nf + iT]]; const nm = (i) => { const t = tn(i); return t.includes('string') || t === 'code' || t === 'array' ? '' : s.strings[N[i * nf + iN]].slice(0, 40); };
  const en = (e) => { const et = etypes[E[e + eT]]; return et === 'element' || et === 'hidden' ? '#' : s.strings[E[e + eN]]; };
  const path = (i, d) => { const p = []; let c = i; for (let k = 0; k < d && ret[c] >= 0; k++) { p.push(`${en(rete[c])}<${tn(ret[c])} ${nm(ret[c])}`); c = ret[c]; } return p.join(' | '); };
  const props = (i) => { const o = new Set(); for (let e = first[i]; e < first[i + 1]; e += ef) if (etypes[E[e + eT]] === 'property') o.add(s.strings[E[e + eN]]); return o; };
  return { ids, cnt, nf, N, iS, iI, tn, nm, path, props };
}
const PROPS = process.env.PROPS?.split(',');
const [A, B] = process.argv.slice(2).map(load); const D = +(process.env.D ?? 4);
function diff(X, Y, label) {
  const g = new Map(), g2 = new Map(); let tot = 0;
  for (let i = 0; i < X.cnt; i++) { const id = X.N[i * X.nf + X.iI]; if (Y.ids.has(id)) continue; if (PROPS && !(X.tn(i) === 'object' && PROPS.every((p) => X.props(i).has(p)))) continue; const sz = X.N[i * X.nf + X.iS]; tot += sz;
    const k = `${X.tn(i)} ${X.nm(i)}`; const o = g.get(k) ?? g.set(k, [0, 0]).get(k); o[0]++; o[1] += sz;
    const k2 = X.path(i, D); const o2 = g2.get(k2) ?? g2.set(k2, [0, 0]).get(k2); o2[0]++; o2[1] += sz; }
  console.log(`=== ${label}: ${(tot / 1048576).toFixed(2)} MB`);
  for (const [k, [n, b]] of [...g].sort((a, b) => b[1][1] - a[1][1]).slice(0, 15)) console.log((b / 1048576).toFixed(2).padStart(7), String(n).padStart(7), k);
  console.log('  by retainer path:');
  for (const [k, [n, b]] of [...g2].sort((a, b) => b[1][1] - a[1][1]).slice(0, 25)) console.log((b / 1048576).toFixed(2).padStart(7), String(n).padStart(7), k.slice(0, 230));
}
diff(A, B, 'died between (alive at a, gone at b)');
if (process.env.BORN) diff(B, A, 'born (alive at b, not at a)');
