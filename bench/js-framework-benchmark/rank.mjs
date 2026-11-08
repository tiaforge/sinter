// Places a local run of sinter into the official js-framework-benchmark table.
// Local and official machines differ, so each framework is scored by its ratio to vanillajs
// measured on the same machine; the official score's ranking is invariant to that choice of base.
import { readFileSync, readdirSync } from 'node:fs';
const JFB = process.argv[2], LOCAL = process.argv[3] ?? 'sinter-v0.8.0-keyed';
const official = JSON.parse(readFileSync(`${JFB}/webdriver-ts/results.json`, 'utf8'));
const CPU = ['01_run1k','02_replace1k','03_update10th1k_x16','04_select1k','05_swap1k','06_remove-one-1k','07_create10k','08_create1k-after1k_x2','09_clear1k_x8'];
const MEM = ['21_ready-memory','22_run-memory','25_run-clear-memory'];
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const vals = (v) => { const x = v.values.total ?? v.values.DEFAULT; return Array.isArray(x) ? x : x.values; };
// official medians per framework/benchmark
const off = new Map();
for (const x of official) { if (!off.has(x.framework)) off.set(x.framework, {}); off.get(x.framework)[x.benchmark] = median(vals(x)); }
const vanillaOff = off.get([...off.keys()].find((k) => /^vanillajs-keyed/.test(k)));
// local medians
const local = {};
for (const f of readdirSync(`${JFB}/webdriver-ts/results`)) {
  const m = /^(.*)_(\d\d_.*)\.json$/.exec(f); if (!m) continue;
  const r = JSON.parse(readFileSync(`${JFB}/webdriver-ts/results/${f}`, 'utf8'));
  (local[m[1]] ??= {})[m[2]] = vals(r).length ? median(vals(r)) : null;
}
const vanillaLoc = local[Object.keys(local).find((k) => /^vanillajs-keyed/.test(k))];
const geo = (xs) => Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / xs.length);
function score(set, m, base) { const xs = set.map((b) => m[b] != null && base[b] ? m[b] / base[b] : null); return xs.some((x) => x == null) ? null : geo(xs); }
for (const [label, set] of [['CPU (9 benchmarks)', CPU], ['memory (3 benchmarks)', MEM]]) {
  const rows = [];
  for (const [fw, m] of off) { const s = score(set, m, vanillaOff); if (s != null) rows.push({ fw, s }); }
  const mine = score(set, local[LOCAL], vanillaLoc);
  if (mine == null) { console.log(`\n## ${label}: local run incomplete for ${LOCAL}`); continue; }
  rows.push({ fw: `**${LOCAL} (local)**`, s: mine, local: true });
  rows.sort((a, b) => a.s - b.s);
  const i = rows.findIndex((r) => r.local);
  console.log(`\n## ${label}: rank ${i + 1} of ${rows.length} (geometric mean of ratios to vanillajs, same machine)\n`);
  console.log('| # | framework | ratio |\n| ---: | --- | ---: |');
  for (let j = 0; j < rows.length; j++) if (j < 12 || Math.abs(j - i) <= 6 || j >= rows.length - 2) console.log(`| ${j + 1} | ${rows[j].fw} | ${rows[j].s.toFixed(2)} |`); else if (j === 12 || j === i + 7) console.log('| … | | |');
  console.log('\nper benchmark, ratio to vanillajs (local sinter / local vanillajs; official medians for reference):\n');
  console.log('| benchmark | vanillajs local ms | sinter local ms | ratio | svelte official | solid official | react-hooks official |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  const ref = (re) => off.get([...off.keys()].find((k) => re.test(k)));
  const [sv, so, re] = [ref(/^svelte-v/), ref(/^solid-v/), ref(/^react-hooks-v/)];
  for (const b of set) console.log(`| ${b} | ${vanillaLoc[b]?.toFixed(2)} | ${local[LOCAL][b]?.toFixed(2)} | ${(local[LOCAL][b] / vanillaLoc[b]).toFixed(2)} | ${(sv[b] / vanillaOff[b]).toFixed(2)} | ${(so[b] / vanillaOff[b]).toFixed(2)} | ${(re[b] / vanillaOff[b]).toFixed(2)} |`);
}
