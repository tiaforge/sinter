// node root1.mjs <a> <b> <type> [props]: for objects of that type alive at a and gone at b, the first holder that is not of the same kind (cons strings, DOM nodes, arrays), grouped
import { readFileSync } from 'node:fs';
const [fa, fb, T, P] = process.argv.slice(2);
const idsOf = (f) => { const s = JSON.parse(readFileSync(f, 'utf8')); const nf = s.snapshot.meta.node_fields.length, iI = s.snapshot.meta.node_fields.indexOf('id'); const o = new Set(); for (let i = 0; i < s.nodes.length; i += nf) o.add(s.nodes[i + iI]); return o; };
const B = idsOf(fb);
const s = JSON.parse(readFileSync(fa, 'utf8')); const m = s.snapshot.meta, nf = m.node_fields.length, ef = m.edge_fields.length, types = m.node_types[0], etypes = m.edge_types[0];
const iT = m.node_fields.indexOf('type'), iN = m.node_fields.indexOf('name'), iS = m.node_fields.indexOf('self_size'), iI = m.node_fields.indexOf('id'), iE = m.node_fields.indexOf('edge_count');
const eT = m.edge_fields.indexOf('type'), eN = m.edge_fields.indexOf('name_or_index'), eTo = m.edge_fields.indexOf('to_node');
const N = s.nodes, E = s.edges, cnt = N.length / nf;
const rev = Array.from({ length: cnt }, () => []); const first = new Uint32Array(cnt + 1);
for (let i = 0, e = 0; i < cnt; i++) { first[i] = e; const ec = N[i * nf + iE]; for (let k = 0; k < ec; k++, e += ef) { if (etypes[E[e + eT]] === 'weak') continue; rev[E[e + eTo] / nf].push([i, e]); } } first[cnt] = E.length;
const tn = (i) => types[N[i * nf + iT]], nm = (i) => s.strings[N[i * nf + iN]];
const en = (e) => { const et = etypes[E[e + eT]]; return et === 'element' || et === 'hidden' ? '#' : s.strings[E[e + eN]]; };
const props = (i) => { const o = new Set(); for (let e = first[i]; e < first[i + 1]; e += ef) if (etypes[E[e + eT]] === 'property') o.add(s.strings[E[e + eN]]); return o; };
const same = (i) => tn(i) === 'concatenated string' || tn(i) === 'sliced string' || tn(i) === 'array' || tn(i) === 'hidden' || (tn(i) === 'object' && (nm(i) === 'Array' || props(i).has('nodeName') || props(i).has('startOffset') || props(i).has('startTag')));
const want = P?.split(',');
const g = new Map(); const memo = new Map();
const holder = (i) => { // BFS up through same-kind nodes to the first other holder
  if (memo.has(i)) return memo.get(i);
  const seen = new Set([i]); let q = [i]; let res = 'none';
  for (let d = 0; d < 400 && q.length && res === 'none'; d++) { const nq = []; for (const c of q) for (const [p, e] of rev[c]) { if (seen.has(p)) continue; seen.add(p); if (tn(p) === 'synthetic') continue; if (same(p)) nq.push(p); else { const up = rev[p].filter(([pp]) => tn(pp) !== 'synthetic').slice(0, 2).map(([pp, ee]) => `${en(ee)}<${tn(pp)} ${nm(pp).slice(0, 30)}`).join(' / '); res = `${en(e)}<${tn(p)} ${nm(p).slice(0, 40)}  [held by ${up}]`; break; } } q = nq.slice(0, 200); }
  memo.set(i, res); return res;
};
let k = 0;
for (let i = 0; i < cnt; i++) { if (tn(i) !== T || B.has(N[i * nf + iI])) continue; if (want && !want.every((x) => props(i).has(x))) continue; if (k++ % 25) continue; // sample
  const h = holder(i); const o = g.get(h) ?? g.set(h, [0, 0]).get(h); o[0]++; o[1] += N[i * nf + iS]; }
for (const [h, [n, b]] of [...g].sort((a, b) => b[1][0] - a[1][0]).slice(0, 12)) console.log(String(n).padStart(6), h.slice(0, 300));
