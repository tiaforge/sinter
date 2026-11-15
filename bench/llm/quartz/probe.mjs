#!/usr/bin/env node
// The leak probe (SPEC.md § Plan: a renamed SvelteKit): does a model recognise Quartz as Svelte/SvelteKit?
//   node quartz/probe.mjs <sample.md> [--models haiku,sonnet,opus] [--n 10] [--out probe-results.json]
// Each question is a fresh headless Claude with no tools and no project settings, asked once about the sample (a
// Quartz page, its data file and an excerpt of the rewritten docs). An answer that names Svelte or SvelteKit is a
// leak. More than 2 leaks in 10 for any model means the disguise does not hold.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: a, positionals: [sampleFile] } = parseArgs({ allowPositionals: true, options: {
  models: { type: 'string', default: 'haiku,sonnet,opus' }, n: { type: 'string', default: '10' }, out: { type: 'string', default: 'probe-results.json' },
} });
const MODELS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
const sample = readFileSync(sampleFile, 'utf8');
const QUESTION = `Below is code and documentation from a web framework. Which existing framework is this, or which existing framework is it based on or derived from? Give your best guess even if unsure: name the framework, say how confident you are (low, medium, high), and give the two clues that decided it.\n\n${sample}`;
const LEAK = /svelte/i; // Svelte, SvelteKit, svelte.dev, vite-plugin-svelte

function ask(model) {
  const cwd = mkdtempSync(join(tmpdir(), 'probe-')); // empty folder: no project files to read
  return new Promise((resolve) => {
    const p = spawn('claude', ['-p', '--model', MODELS[model], '--output-format', 'json', '--setting-sources', 'project', '--strict-mcp-config',
      '--no-session-persistence', '--disallowedTools', 'Bash Read Write Edit Glob Grep WebFetch WebSearch Agent Task TodoWrite'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', (d) => (out += d)); p.stdin.end(QUESTION);
    p.on('close', () => { try { const r = JSON.parse(out); resolve({ answer: r.result ?? '', cost: r.total_cost_usd ?? 0 }); } catch { resolve({ answer: `(no answer: ${out.slice(0, 200)})`, cost: 0 }); } });
  });
}

const results = [];
for (const model of a.models.split(',')) {
  for (let i = 0; i < Number(a.n); i++) {
    const { answer, cost } = await ask(model);
    results.push({ model, i, leak: LEAK.test(answer), answer, cost });
    process.stdout.write(`${model} ${i + 1}: ${LEAK.test(answer) ? 'LEAK' : 'ok  '} ${answer.replace(/\s+/g, ' ').slice(0, 110)}\n`);
  }
}
writeFileSync(a.out, JSON.stringify(results, null, 2));
for (const model of a.models.split(',')) {
  const r = results.filter((x) => x.model === model), leaks = r.filter((x) => x.leak).length;
  console.log(`${model}: ${leaks}/${r.length} name Svelte${leaks > 2 ? ' → the disguise does not hold' : ''}`);
}
console.log(`cost $${results.reduce((n, x) => n + x.cost, 0).toFixed(2)}`);
