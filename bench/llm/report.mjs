#!/usr/bin/env node
// Tables from a run directory's results.json: node report.mjs <out> [> results.md]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const all = JSON.parse(readFileSync(join(process.argv[2], 'results.json'), 'utf8'));
const rows = all.filter((r) => !r.leaks?.length);
const FW = ['sinter', 'astro', 'sveltekit'], MODELS = ['haiku', 'sonnet', 'opus'], TASKS = ['t1', 't2', 't3'];
const BASE = { t2: 5 }; // checks the untouched base already passes
const cell = (t, f, m) => rows.filter((r) => r.task === t && r.framework === f && r.model === m);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };
const rate = (r) => (r.total ? r.passed / r.total : 0);
const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
const usd = (x) => (x == null ? '–' : `$${x.toFixed(2)}`);

let md = '';
for (const t of TASKS) {
  const any = rows.filter((r) => r.task === t);
  if (!any.length) continue;
  const total = any.find((r) => r.total)?.total;
  md += `\n### ${t.toUpperCase()}: checks passed (of ${total}${BASE[t] ? `; the untouched base passes ${BASE[t]}` : ''}) · cost · minutes\n\n`;
  md += `| framework | ${MODELS.join(' | ')} |\n| --- | ${MODELS.map(() => '---:').join(' | ')} |\n`;
  for (const f of FW) {
    if (!any.some((r) => r.framework === f)) { md += `| ${f} | ${MODELS.map(() => 'n/a').join(' | ')} |\n`; continue; }
    md += `| ${f} | ${MODELS.map((m) => {
      const c = cell(t, f, m);
      if (!c.length) return '–';
      return `**${c.map((r) => r.passed ?? 0).join(', ')}**${c.some((r) => !r.build) ? ' (build failed)' : ''} · ${usd(median(c.map((r) => r.costUSD ?? 0)))} · ${Math.round(median(c.map((r) => r.seconds)) / 60)} min`;
    }).join(' | ')} |\n`;
  }
}
md += `\n### Per framework (all its runs)\n\n| framework | mean pass rate | all checks pass | builds | median cost | median minutes | doc reads / run | web fetches / run | build or check runs / run | lines written (median) |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n`;
for (const f of FW) {
  const r = rows.filter((x) => x.framework === f);
  if (!r.length) continue;
  md += `| ${f} | ${pct(mean(r.map(rate)))} | ${r.filter((x) => x.passed === x.total).length}/${r.length} | ${r.filter((x) => x.build).length}/${r.length} | ${usd(median(r.map((x) => x.costUSD ?? 0)))} | ${Math.round(median(r.map((x) => x.seconds)) / 60)} | ${mean(r.map((x) => x.docReads)).toFixed(1)} | ${mean(r.map((x) => x.webFetches.length)).toFixed(1)} | ${mean(r.map((x) => x.buildRuns)).toFixed(1)} | ${median(r.map((x) => x.linesAdded))} |\n`;
}
md += `\n### Mean pass rate per model, T1 and T3 only (the tasks every framework ran)\n\n| model | ${FW.join(' | ')} |\n| --- | ${FW.map(() => '---:').join(' | ')} |\n`;
for (const m of MODELS) md += `| ${m} | ${FW.map((f) => pct(mean(rows.filter((x) => x.framework === f && x.model === m && x.task !== 't2').map(rate)))).join(' | ')} |\n`;
md += `\n### Failed checks per run\n\n`;
for (const r of rows.filter((x) => x.passed !== x.total)) md += `- **${r.id}**${r.build ? '' : ' (build failed)'}: ${r.failed.join('; ') || '–'}\n`;
const excluded = all.filter((r) => r.leaks?.length);
if (excluded.length) md += `\nExcluded for touching the sinter repository: ${excluded.map((r) => `${r.id} (${r.leaks[0].slice(0, 80)})`).join(', ')}\n`;
console.log(md);
