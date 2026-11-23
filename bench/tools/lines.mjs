// node lines.mjs <profile> <functionName> [line]: self ticks by source line of that function (positionTicks)
import { readFileSync } from 'node:fs';
const [file, fn, at] = process.argv.slice(2);
const p = JSON.parse(readFileSync(file, 'utf8'));
const lines = new Map(); let total = 0;
for (const n of p.nodes) {
  if (n.callFrame.functionName !== fn || (at && n.callFrame.lineNumber + 1 !== +at)) continue;
  for (const t of n.positionTicks ?? []) { lines.set(t.line, (lines.get(t.line) ?? 0) + t.ticks); total += t.ticks; }
}
const url = p.nodes.find((n) => n.callFrame.functionName === fn && (!at || n.callFrame.lineNumber + 1 === +at) && n.callFrame.url.startsWith('file:'))?.callFrame.url;
const src = url ? readFileSync(new URL(url), 'utf8').split('\n') : [];
console.log('ticks', total);
for (const [l, t] of [...lines].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(String(t).padStart(6), l, (src[l - 1] ?? '').trim().slice(0, 150));
