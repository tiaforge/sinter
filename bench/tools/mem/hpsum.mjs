// node hpsum.mjs <profile.json> [by=fn|file|stack] [top] [filter]: allocated MB by allocating function (self), by file, or by inclusive frame
import { readFileSync } from 'node:fs';
const [f, by = 'fn', top = '40', filt] = process.argv.slice(2);
const p = JSON.parse(readFileSync(f, 'utf8'));
const self = new Map(), incl = new Map(); let total = 0;
const key = (cf) => by === 'file' ? cf.url.replace(/.*node_modules\//, 'nm/').replace(/.*\/(dist|src)\//, '$1/') : `${cf.functionName || '(anon)'} ${cf.url.replace(/.*\//, '')}:${cf.lineNumber + 1}`;
function walk(n, stack, parentK) {
  let k = key(n.callFrame); const sz = n.selfSize;
  if (!n.callFrame.url && parentK && by !== 'stack') k = parentK + ' > ' + (n.callFrame.functionName || '(native)');
  total += sz; self.set(k, (self.get(k) ?? 0) + sz);
  const st = new Set(stack); st.add(k);
  if (sz) for (const x of st) incl.set(x, (incl.get(x) ?? 0) + sz);
  for (const c of n.children) walk(c, st, n.callFrame.url ? k : parentK);
}
walk(p.head, new Set(), null);
const m = by === 'stack' ? incl : self;
console.log('total MB', (total / 1048576).toFixed(0));
for (const [k, v] of [...m].filter(([k]) => !filt || k.includes(filt)).sort((a, b) => b[1] - a[1]).slice(0, +top)) console.log((v / 1048576).toFixed(1).padStart(8), k);
