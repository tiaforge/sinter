// node prof.mjs <file.cpuprofile> [under-frame-name] [top N]: self time by function (optionally only under a frame), and inclusive by function
import { readFileSync } from 'node:fs';
const [file, under, topN = 40] = process.argv.slice(2);
const p = JSON.parse(readFileSync(file, 'utf8'));
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const dt = new Map();
for (let i = 0; i < p.samples.length; i++) dt.set(p.samples[i], (dt.get(p.samples[i]) ?? 0) + (p.timeDeltas[i] ?? 0) / 1000);
const label = (n) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').slice(-2).join('/')}:${n.callFrame.lineNumber + 1}`;
const self = new Map(), incl = new Map();
let total = 0;
for (const [id, ms] of dt) {
  let chain = [], x = id;
  while (x !== undefined) { chain.push(byId.get(x)); x = parent.get(x); }
  if (under && !chain.some((n) => n.callFrame.functionName === under)) continue;
  total += ms;
  const l = label(chain[0]); self.set(l, (self.get(l) ?? 0) + ms);
  const seen = new Set();
  for (const n of chain) { const k = label(n); if (seen.has(k)) continue; seen.add(k); incl.set(k, (incl.get(k) ?? 0) + ms); if (under && n.callFrame.functionName === under) break; }
}
console.log('total', total.toFixed(1));
console.log('-- self');
for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, +topN)) console.log(v.toFixed(1).padStart(8), k);
console.log('-- inclusive');
for (const [k, v] of [...incl].sort((a, b) => b[1] - a[1]).slice(0, +topN)) console.log(v.toFixed(1).padStart(8), k);
