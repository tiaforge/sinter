// node gcsum.mjs <trace-gc output>: pauses summed by kind
import { readFileSync } from 'node:fs';
const o = {}; let last = '';
for (const l of readFileSync(process.argv[2], 'utf8').split('\n')) {
  const m = /ms: (Scavenge|Mark-Compact|Minor Mark-Sweep|Mark-Sweep)[^,]*MB, (?:pooled: [\d.]+ MB, )?([\d.]+) \/ ([\d.]+) ms/.exec(l); if (!m) continue;
  const k = m[1]; o[k] ??= { n: 0, ms: 0 }; o[k].n++; o[k].ms += +m[2]; last = l;
}
for (const k in o) o[k].ms = +o[k].ms.toFixed(1);
console.log(JSON.stringify(o), 'total', Object.values(o).reduce((a, b) => a + b.ms, 0).toFixed(1));
