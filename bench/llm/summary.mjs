#!/usr/bin/env node
// Medians and ranges per task and framework for a run directory with repetitions:
//   node summary.mjs <out> [> summary.md]
// Reads results-regraded.json when there is one (the idle, serial grading), else results.json, and each run's
// transcript (transcript.mjs) for turns, cost, tokens, debugging rounds, docs and diagnostics.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyze } from './transcript.mjs';

const out = process.argv[2];
const file = existsSync(join(out, 'results-regraded.json')) ? 'results-regraded.json' : 'results.json';
const rows = JSON.parse(readFileSync(join(out, file), 'utf8')).map((r) => ({ ...r, t: analyze(join(out, r.id)) }));
const FW = ['sinter', 'astro', 'sveltekit'];
const stat = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); if (!s.length) return null; return { med: s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2, min: s[0], max: s.at(-1) }; };
const fmt = (st, f = (x) => x) => (st ? `${f(st.med)} (${f(st.min)}–${f(st.max)})` : '–');
const usd = (x) => `$${x.toFixed(2)}`, m = (x) => `${(x / 1e6).toFixed(1)}M`, min = (x) => `${Math.round(x / 60)}`;

let md = `# Summary of ${out}\n\nGraded from \`${file}\`. Each cell: median (min–max) over its runs.\n`;
for (const task of [...new Set(rows.map((r) => r.task))].sort()) {
  const total = rows.find((r) => r.task === task)?.total;
  md += `\n## ${task.toUpperCase()} (${total} checks)\n\n| framework | runs | checks | turns | cost | minutes* | input tokens | debugging rounds | JS gz, page 1 (KB) |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n`;
  for (const fw of FW) {
    const c = rows.filter((r) => r.task === task && r.framework === fw);
    if (!c.length) continue;
    const js = c.map((r) => Object.values(r.measure?.weight ?? {})[0]?.jsGz).filter((x) => x != null).map((x) => +(x / 1024).toFixed(1));
    md += `| ${fw} | ${c.length} | ${fmt(stat(c.map((r) => r.passed)))} | ${fmt(stat(c.map((r) => r.t.turns)))} | ${fmt(stat(c.map((r) => r.t.costUSD)), usd)} | ${fmt(stat(c.map((r) => r.seconds)), min)} | ${fmt(stat(c.map((r) => r.t.inputTokens)), m)} | ${fmt(stat(c.map((r) => r.t.debugRounds)))} | ${fmt(stat(js))} |\n`;
  }
}
md += `\n*Minutes are with the agents running in parallel (parallelSlots in meta.json); turns, cost and tokens do not depend on load.\n`;

md += `\n## Failed grader checks\n\n`;
const failed = rows.filter((r) => r.passed !== r.total);
md += failed.length ? failed.map((r) => `- ${r.id}${r.build ? '' : ' (build failed)'}: ${r.failed.join('; ') || '(no checks ran)'}`).join('\n') + '\n' : 'None.\n';
for (const r of failed) {
  const g = existsSync(join(out, r.id, 'grade.json')) ? JSON.parse(readFileSync(join(out, r.id, 'grade.json'), 'utf8')) : null;
  for (const c of g?.checks?.filter((x) => !x.pass) ?? []) md += `  - ${r.id} "${c.name}": ${c.error}\n`;
}

md += `\n## sinter: diagnostics that failed a build or check, render and docs\n\n| run | failed builds / checks | SN codes (count) | \`sinter render\` | \`sinter docs\` | llms reads | early="off" |\n| --- | ---: | --- | ---: | ---: | ---: | ---: |\n`;
const totals = {};
for (const r of rows.filter((x) => x.framework === 'sinter').sort((a, b) => a.id.localeCompare(b.id))) {
  const a = r.t;
  for (const [k, v] of Object.entries(a.failedDiagnostics)) totals[k] = (totals[k] ?? 0) + v;
  // in the agent's own pages (the docs mention the attribute too, so the transcript would not tell)
  const early = (() => { try { return execFileSync('grep', ['-rl', '--include=*.html', '--exclude-dir=node_modules', '--exclude-dir=dist', 'early="off"', join(out, r.id, 'workspace')]).toString().trim().length > 0; } catch { return false; } })();
  md += `| ${r.id} | ${a.builds.failed} / ${a.checks.failed} | ${Object.entries(a.failedDiagnostics).map(([k, v]) => `${k} ×${v}`).join(', ') || '–'} | ${a.sinterRender} | ${a.sinterDocs} | ${a.docReads} | ${early ? 'yes' : '–'} |\n`;
}
md += `\nAll sinter runs: ${Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join(', ') || 'no failing diagnostics'}.\n`;
console.log(md);
