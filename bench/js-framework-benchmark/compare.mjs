// Prints a markdown table from js-framework-benchmark result files:
// median total time per CPU benchmark, slowdown geometric mean vs a base framework
// (like the official table), and bundle sizes.
//   [BASE=svelte] [ONLY=sinter,svelte] node compare.mjs <path to js-framework-benchmark/webdriver-ts/results>
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? '../../../bench/js-framework-benchmark/webdriver-ts/results';
const results = {}, only = process.env.ONLY?.split(','), baseName = process.env.BASE ?? 'vanillajs';
for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const name = d.framework.replace(/-keyed$/, '').replace(/-v[\d.]+.*$/, '');
  const v = d.values.total ?? d.values.DEFAULT ?? Object.values(d.values)[0];
  if (!only || only.includes(name)) (results[name] ??= {})[d.benchmark] = v.median;
}
const cpu = [...new Set(Object.values(results).flatMap((r) => Object.keys(r)))].filter((b) => /^0/.test(b) && Object.values(results).every((r) => b in r)).sort();
const base = results[baseName];
const geo = (r) => Math.exp(cpu.reduce((s, b) => s + Math.log(r[b] / base[b]), 0) / cpu.length);
const names = Object.keys(results).sort((a, b) => (base ? geo(results[a]) - geo(results[b]) : a.localeCompare(b)));
const kb = (r, b) => (r[b] == null ? '' : r[b].toFixed(1));

console.log(`| benchmark (ms, median) | ${names.join(' | ')} |`);
console.log(`| --- | ${names.map(() => '---:').join(' | ')} |`);
for (const b of cpu) console.log(`| ${b} | ${names.map((n) => results[n][b]?.toFixed(1) ?? '').join(' | ')} |`);
if (base) console.log(`| **geometric mean vs ${baseName}** | ${names.map((n) => `**${geo(results[n]).toFixed(2)}**`).join(' | ')} |`);
console.log(`| size, uncompressed (KB) | ${names.map((n) => kb(results[n], '41_size-uncompressed')).join(' | ')} |`);
console.log(`| size, compressed (KB) | ${names.map((n) => kb(results[n], '42_size-compressed')).join(' | ')} |`);
console.log(`| first paint (ms) | ${names.map((n) => kb(results[n], '43_first-paint')).join(' | ')} |`);
