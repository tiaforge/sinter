// node bench/realnet/summary.mjs <loads.jsonl>   medians [min-max] by label: first paint, largest paint, data in DOM,
// marks; the protocols seen (check every load: a fallback to HTTP/1.1 is silent)
import { readFileSync } from 'node:fs';
const rows = readFileSync(process.argv[2], 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const med = (a) => { const s = a.filter((x) => typeof x == 'number').sort((x, y) => x - y); return s.length ? `${s[s.length >> 1].toFixed(0)} [${s[0].toFixed(0)}-${s.at(-1).toFixed(0)}]` : '-'; };
const by = Map.groupBy(rows, (r) => r.label);
const marks = [...new Set(rows.flatMap((r) => Object.keys(r.marks)))];
console.log(`| label | loads | protocols | first paint | largest paint | data in DOM | ${marks.join(' | ')}${marks.length ? ' |' : ''}`);
console.log(`| --- | ---: | --- | ---: | ---: | ---: |${marks.map(() => ' ---: |').join('')}`);
for (const [label, rs] of by) {
  const protocols = [...new Set(rs.flatMap((r) => [r.protocol, ...r.requests.map((q) => q.protocol)]).filter(Boolean))].join(', ');
  console.log(`| ${label} | ${rs.length} | ${protocols} | ${med(rs.map((r) => r.fcp))} | ${med(rs.map((r) => r.lcp))} | ${med(rs.map((r) => r.dataInDom))} |${marks.map((m) => ` ${med(rs.map((r) => r.marks[m]))} |`).join('')}`);
}
