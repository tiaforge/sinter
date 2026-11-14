#!/usr/bin/env node
// What an agent spent its run on, from its transcript: node transcript.mjs <run dir>… [--json]
// Builds and checks are classified by what the tool printed, since agents pipe them through `tail` and the exit code
// is lost: a Vite build by "✓ built in" against "error during build" / "Build failed"; `sinter check` by its summary
// ("N error(s)"); Astro and Svelte checks by their summaries. Diagnostics are counted from their own lines
// (`file:line:col error SNxxx …`), not from hints that mention a code again. A command that runs several of these
// counts each.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2), json = args.includes('--json');

export function analyze(dir) {
  const lines = readFileSync(join(dir, 'transcript.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const results = new Map();
  for (const l of lines) if (l.type === 'user') for (const c of l.message?.content ?? []) if (c.type === 'tool_result') results.set(c.tool_use_id, typeof c.content === 'string' ? c.content : (c.content ?? []).map((x) => x.text ?? '').join(''));
  const out = { builds: { ok: 0, failed: 0 }, checks: { ok: 0, failed: 0 }, failedDiagnostics: {}, docReads: 0, docChars: 0, sinterDocs: 0, debugRounds: 0, toolCalls: 0, failures: [] };
  for (const l of lines) if (l.type === 'assistant') for (const u of l.message?.content ?? []) {
    if (u.type !== 'tool_use') continue;
    out.toolCalls++;
    const input = JSON.stringify(u.input), r = results.get(u.id) ?? '';
    if (/llms(-full|-small)?\.txt|framework-docs\//.test(input)) { out.docReads++; out.docChars += r.length; }
    if (u.name !== 'Bash') continue;
    const cmd = u.input.command ?? '';
    out.sinterDocs += (cmd.match(/\bsinter docs\b/g) ?? []).length;
    // the agent's own checking of the running app: a browser script, curl or wget against it (not builds, not doc fetches)
    if ((/playwright|chromium|\bcurl\b|\bwget\b/.test(cmd) || /\bnode\s+(?!api\/server)[^-\s]\S*\.m?js\b/.test(cmd)) && !/raw\.githubusercontent|npmjs|registry|\bnpm run build\b|vite build/.test(cmd)) out.debugRounds++;
    // Vite builds (sinter, Astro and SvelteKit all build with Vite): one verdict per build in the output
    const count = (re) => (r.match(re) ?? []).length;
    // a failed build prints "error during build:" and also "Build failed …": one verdict, whichever phrasing is there
    const built = count(/✓ built in/g), broke = Math.max(count(/error during build/g), count(/Build failed in \d/g), Math.min(1, count(/Build failed/g)));
    out.builds.ok += built; out.builds.failed += broke;
    // sinter check summaries: `sinter check …: 3 page(s), 9 error(s) …`
    for (const m of r.matchAll(/sinter check[^:\n]*: \d+ page\(s\), (\d+) error\(s\)/g)) (Number(m[1]) ? out.checks.failed++ : out.checks.ok++);
    // astro check / svelte-check summaries
    for (const m of r.matchAll(/(?:Result \(\d+ files?\):[^\n]*?- (\d+) errors?|svelte-check found (\d+) errors?)/g)) (Number(m[1] ?? m[2]) ? out.checks.failed++ : out.checks.ok++);
    if (broke || /\b[1-9]\d* error\(s\)/.test(r)) {
      const diags = [...r.matchAll(/^\S+:\d+:\d+ error (SN\d{3}) ([^\n]{0,160})/gm)].map((m) => `${m[1]} ${m[2]}`);
      for (const d of diags) { const code = d.slice(0, 5); out.failedDiagnostics[code] = (out.failedDiagnostics[code] ?? 0) + 1; }
      out.failures.push({ command: cmd.slice(0, 120).replace(/\n/g, ' ⏎ '), diagnostics: diags.slice(0, 12), other: diags.length ? undefined : (r.match(/(error during build[^\n]*|Build failed[^\n]*|\[[A-Z_]+\][^\n]*)/) ?? [])[0]?.slice(0, 200) });
    }
  }
  const res = lines.findLast((l) => l.type === 'result') ?? {};
  out.turns = res.num_turns ?? null; out.costUSD = res.total_cost_usd ?? null;
  out.inputTokens = (res.usage?.input_tokens ?? 0) + (res.usage?.cache_read_input_tokens ?? 0) + (res.usage?.cache_creation_input_tokens ?? 0);
  out.outputTokens = res.usage?.output_tokens ?? null;
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const dir of args.filter((x) => x !== '--json')) {
    const a = analyze(dir);
    if (json) { console.log(JSON.stringify({ dir, ...a })); continue; }
    console.log(`${dir.split('/').pop()}: turns ${a.turns}, input ${(a.inputTokens / 1e6).toFixed(1)}M, builds ${a.builds.ok} ok / ${a.builds.failed} failed, checks ${a.checks.ok} ok / ${a.checks.failed} failed, docs read ${a.docReads}× (${Math.round(a.docChars / 1000)} KB), sinter docs ${a.sinterDocs}×, debugging rounds ${a.debugRounds}${Object.keys(a.failedDiagnostics).length ? ', failing diagnostics ' + JSON.stringify(a.failedDiagnostics) : ''}`);
    for (const f of a.failures) console.log(`  ✗ ${f.command}\n    ${f.diagnostics.length ? f.diagnostics.join('\n    ') : f.other ?? ''}`);
  }
}
