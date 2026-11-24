// node hpratio.mjs <all.json> <major-only.json> [top]: per allocating function, MB allocated, MB surviving to old space, the ratio
import { readFileSync } from 'node:fs';
const sum = (f) => { const p = JSON.parse(readFileSync(f, 'utf8')); const m = new Map();
  const key = (cf) => `${cf.functionName || '(anon)'} ${cf.url.replace(/.*\//, '')}:${cf.lineNumber + 1}`;
  (function w(n, pk) { let k = key(n.callFrame); if (!n.callFrame.url && pk) k = pk + ' > ' + (n.callFrame.functionName || '(native)'); m.set(k, (m.get(k) ?? 0) + n.selfSize); for (const c of n.children) w(c, n.callFrame.url ? k : pk); })(p.head, null); return m; };
const [a, b] = process.argv.slice(2, 4).map(sum);
const rows = [...b].map(([k, v]) => [k, a.get(k) ?? 0, v]).sort((x, y) => y[2] - x[2]).slice(0, +(process.argv[4] ?? 40));
for (const [k, al, pr] of rows) console.log((al / 1048576).toFixed(1).padStart(8), (pr / 1048576).toFixed(1).padStart(7), (al ? (100 * pr / al).toFixed(0) + '%' : '-').padStart(5), k);
