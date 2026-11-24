// node hpunder.mjs <profile> <rootFn> <fn,…>: MB allocated under rootFn (inclusive), and of it under each fn (first match on the stack, inner wins)
import { readFileSync } from 'node:fs';
const [f, root, list] = process.argv.slice(2); const fns = list.split(',');
const p = JSON.parse(readFileSync(f, 'utf8')); const o = Object.fromEntries(fns.map((x) => [x, 0])); let tot = 0, other = 0;
(function w(n, inRoot, cur) { const name = n.callFrame.functionName; const r = inRoot || name === root; const c = fns.includes(name) ? name : cur;
  if (r) { tot += n.selfSize; if (c) o[c] += n.selfSize; else other += n.selfSize; } for (const k of n.children) w(k, r, c); })(p.head, false, null);
const mb = (x) => (x / 1048576).toFixed(0);
console.log(root, 'total', mb(tot), Object.entries(o).map(([k, v]) => `${k} ${mb(v)}`).join(', '), 'other', mb(other));
