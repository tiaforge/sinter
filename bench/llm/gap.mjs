#!/usr/bin/env node
// The familiarity gap: how much a framework's docs change an agent's run, per task and framework.
//   node gap.mjs <docs run dir> <cold run dir>
// Medians over the repetitions of checks passed, cost and turns (turns and cost from each transcript, transcript.mjs),
// and docs minus cold. A framework the model already knows well gains little from its docs; one it does not know
// gains more, so a large drop in cost or turns under docs marks a gap the model's training leaves.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyze } from './transcript.mjs';

const [docsDir, coldDir] = process.argv.slice(2);
const load = (dir) => {
  const f = existsSync(join(dir, 'results-regraded.json')) ? 'results-regraded.json' : 'results.json';
  return JSON.parse(readFileSync(join(dir, f), 'utf8')).map((r) => ({ ...r, ...pick(analyze(join(dir, r.id))) }));
};
const pick = (a) => ({ turnsT: a.turns, costT: a.costUSD });
const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const docs = load(docsDir), cold = load(coldDir);
const tasks = [...new Set([...docs, ...cold].map((r) => r.task))].sort(), fws = ['sinter', 'astro', 'sveltekit'];
const stat = (rows) => ({ n: rows.length, pass: median(rows.map((r) => r.passed)), total: rows[0]?.total, cost: median(rows.map((r) => r.costT)), turns: median(rows.map((r) => r.turnsT)) });
const f$ = (x) => (x == null ? '–' : `$${x.toFixed(2)}`), d$ = (x) => (x == null ? '–' : `${x >= 0 ? '+' : '−'}$${Math.abs(x).toFixed(2)}`);
const dn = (x) => (x == null ? '–' : `${x >= 0 ? '+' : '−'}${Math.abs(x)}`), pct = (a, b) => (a == null || !b ? '' : ` (${a >= b ? '+' : '−'}${Math.round(Math.abs(a / b - 1) * 100)}%)`);

console.log('| task | framework | checks cold → docs | cost cold → docs | Δ cost | turns cold → docs | Δ turns |\n|---|---|---|---|---|---|---|');
const totals = {};
for (const t of tasks) for (const fw of fws) {
  const c = stat(cold.filter((r) => r.task === t && r.framework === fw)), d = stat(docs.filter((r) => r.task === t && r.framework === fw));
  if (!c.n && !d.n) continue;
  for (const [k, v] of [['cold', c], ['docs', d]]) { const o = (totals[fw] ??= { cold: { cost: 0, turns: 0 }, docs: { cost: 0, turns: 0 } }); o[k].cost += v.cost ?? 0; o[k].turns += v.turns ?? 0; }
  console.log(`| ${t} | ${fw} | ${c.pass ?? '–'}/${c.total ?? '–'} → ${d.pass ?? '–'}/${d.total ?? '–'} | ${f$(c.cost)} → ${f$(d.cost)} | ${c.cost != null && d.cost != null ? d$(d.cost - c.cost) + pct(d.cost, c.cost) : '–'} | ${c.turns ?? '–'} → ${d.turns ?? '–'} | ${c.turns != null && d.turns != null ? dn(d.turns - c.turns) + pct(d.turns, c.turns) : '–'} |`);
}
console.log('\nSums of the medians over the tasks each framework ran (T2 has no Astro base):\n\n| framework | cost cold → docs | turns cold → docs |\n|---|---|---|');
for (const fw of fws) { const o = totals[fw]; if (o) console.log(`| ${fw} | ${f$(o.cold.cost)} → ${f$(o.docs.cost)}${pct(o.docs.cost, o.cold.cost)} | ${o.cold.turns} → ${o.docs.turns}${pct(o.docs.turns, o.cold.turns)} |`); }
