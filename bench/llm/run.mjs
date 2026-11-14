#!/usr/bin/env node
// Runs the agent benchmark: every task × framework × model × repetition, in parallel slots, then grades each run.
//   node run.mjs [--tasks t1,t2,t3] [--frameworks sinter,astro,sveltekit] [--models haiku,sonnet,opus]
//                [--reps 1] [--slots 3] [--condition cold] [--budget 15] [--out /tmp/llmbench/runs/<time>]
// Results: <out>/results.json (one row per run) and <out>/<run>/{transcript.jsonl,grade.json,meta.json,workspace/}.
// See SPEC.md for what is measured and why.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { run } from './lib.mjs';

const here = new URL('.', import.meta.url).pathname;
const { values: a } = parseArgs({ options: {
  tasks: { type: 'string', default: 't1,t2,t3' }, frameworks: { type: 'string', default: 'sinter,astro,sveltekit' },
  models: { type: 'string', default: 'haiku,sonnet,opus' }, reps: { type: 'string', default: '1' }, slots: { type: 'string', default: '3' },
  condition: { type: 'string', default: 'cold' }, budget: { type: 'string', default: '15' }, timeout: { type: 'string', default: '45' },
  out: { type: 'string' }, bases: { type: 'string', default: '/tmp/llmbench/bases' }, 'grade-only': { type: 'boolean', default: false },
} });

const MODELS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
// How each framework is named in the prompt: what a developer would type. sinter is new, so its npm package is named
// as well (the others are found by name alone); nothing else differs between the frameworks' prompts.
const FRAMEWORKS = {
  sinter: { name: 'sinter (the npm package `@tiaforge-ui/sinter`)' },
  astro: { name: 'Astro' },
  sveltekit: { name: 'SvelteKit' },
};
const TASKS = {
  t1: { dir: 'tasks/t1-incidents', workspace: 'tasks/t1-incidents/workspace' },
  t2: { dir: 'tasks/t2-realworld', base: true }, // starts from <bases>/<framework> (setup.mjs); no Astro base exists
  t3: { dir: 'tasks/t3-content', workspace: 'tasks/t3-content/workspace' },
};
// Conditions (SPEC.md § Conditions). cold: no docs given, web tools allowed: an agent as people use it today.
const CONDITIONS = {
  cold: { tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite'] },
  offline: { tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite'] },
};

const out = a.out ?? `/tmp/llmbench/runs/${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(out, { recursive: true });
const cond = CONDITIONS[a.condition];
const jobs = [];
for (const t of a.tasks.split(',')) for (const f of a.frameworks.split(',')) for (const m of a.models.split(',')) for (let r = 1; r <= Number(a.reps); r++) {
  if (TASKS[t].base && !existsSync(join(a.bases, f))) { console.log(`skip ${t}/${f}: no base project`); continue; }
  jobs.push({ task: t, framework: f, model: m, rep: r, id: `${t}-${f}-${m}-${a.condition}-r${r}` });
}
// interleave so that slow runs (Opus, T1) spread over the slots, and an early stop still covers every cell
jobs.sort((x, y) => x.rep - y.rep || x.model.localeCompare(y.model) || x.task.localeCompare(y.task) || x.framework.localeCompare(y.framework));
console.log(`${jobs.length} runs → ${out}`);

const killPorts = (ports) => run('sh', ['-c', ports.map((p) => `fuser -k -n tcp ${p} 2>/dev/null`).join('; ') + '; true']);

async function agent(job, slot) {
  const dir = join(out, job.id), ws = join(dir, 'workspace');
  const PORT = 4400 + slot, API_PORT = 3100 + slot;
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const T = TASKS[job.task];
  if (T.base) cpSync(join(a.bases, job.framework), ws, { recursive: true });
  else cpSync(join(here, T.workspace), ws, { recursive: true });
  for (const f of ['api/server.mjs', 'api/API.md']) if (existsSync(join(ws, f))) writeFileSync(join(ws, f), readFileSync(join(ws, f), 'utf8').replaceAll('3001', String(API_PORT)));
  if (!existsSync(join(ws, '.git'))) await run('sh', ['-c', 'git init -q && git add -A && git -c user.name=bench -c user.email=bench@localhost commit -qm base --allow-empty'], { cwd: ws });
  const prompt = readFileSync(join(here, T.dir, 'PROMPT.md'), 'utf8')
    .replaceAll('{{FRAMEWORK}}', FRAMEWORKS[job.framework].name).replaceAll('{{PORT}}', String(PORT)).replaceAll('{{API_PORT}}', String(API_PORT));
  writeFileSync(join(dir, 'prompt.md'), prompt);
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^CLAUDE_(CODE_)?ADDITIONAL_DIRECTORIES/.test(k)) delete env[k];
  const args = ['-p', prompt, '--model', MODELS[job.model], '--output-format', 'stream-json', '--verbose',
    '--allowedTools', cond.tools.join(' '), '--disallowedTools', 'Agent Task',
    '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence', '--max-budget-usd', a.budget];
  const t0 = Date.now();
  const res = await new Promise((resolve) => {
    const p = spawn('claude', args, { cwd: ws, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const chunks = []; let err = '';
    p.stdout.on('data', (d) => chunks.push(d)); p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch {} }, Number(a.timeout) * 60_000);
    p.on('close', (code) => { clearTimeout(timer); try { process.kill(-p.pid, 'SIGKILL'); } catch {} resolve({ code, stdout: Buffer.concat(chunks).toString(), stderr: err }); });
  });
  writeFileSync(join(dir, 'transcript.jsonl'), res.stdout);
  await killPorts([PORT, API_PORT]); // anything the agent left on its ports (its process group is killed above)
  const meta = { ...job, slot, PORT, API_PORT, condition: a.condition, exit: res.code, seconds: Math.round((Date.now() - t0) / 1000), stderr: res.stderr.slice(-2000), ...transcriptStats(res.stdout) };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return { dir, ws, PORT, API_PORT, meta };
}

/** Process metrics from the stream-json transcript: cost, turns, tokens, tool use, doc reads, leaks outside the workspace. */
function transcriptStats(text) {
  const lines = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const result = lines.findLast((l) => l.type === 'result') ?? {};
  const uses = lines.filter((l) => l.type === 'assistant').flatMap((l) => (l.message?.content ?? []).filter((c) => c.type === 'tool_use'));
  const tools = {}; for (const u of uses) tools[u.name] = (tools[u.name] ?? 0) + 1;
  const inputs = uses.map((u) => JSON.stringify(u.input ?? {}));
  const urls = uses.filter((u) => u.name === 'WebFetch').map((u) => u.input?.url);
  const searches = uses.filter((u) => u.name === 'WebSearch').map((u) => u.input?.query);
  const docReads = inputs.filter((s) => /llms(-full)?\.txt|AGENTS\.md|CLAUDE\.md|node_modules\/[^"]*\/(docs?|README)/i.test(s)).length;
  const builds = uses.filter((u) => u.name === 'Bash' && /\b(npm run (build|check)|vite build|astro (build|check)|svelte-check|sinter check)\b/.test(u.input?.command ?? '')).length;
  // the agent must not see this repository (examples/realworld would be an answer key): any path into it is flagged
  const leaks = inputs.filter((s) => /\/home\/user\b|tiaforge\/sinter\/(tree|blob)\/[^"]*examples/.test(s)).slice(0, 5);
  return {
    costUSD: result.total_cost_usd ?? null, turns: result.num_turns ?? null, apiSeconds: result.duration_api_ms ? Math.round(result.duration_api_ms / 1000) : null,
    outputTokens: result.usage?.output_tokens ?? null, resultSubtype: result.subtype ?? null, toolCalls: uses.length, tools,
    webFetches: urls, webSearches: searches, docReads, buildRuns: builds, leaks,
  };
}

/** Source size of what the agent wrote (or changed, for a base project): files and non-blank lines, from git. */
async function sourceStats(ws) {
  await run('sh', ['-c', 'git add -A >/dev/null 2>&1'], { cwd: ws });
  const ex = ["':!*lock*'", "':!node_modules'", "':!dist'", "':!build'", "':!.svelte-kit'", "':!.astro'", "':!*.d.ts'"].join(' ');
  const d = await run('sh', ['-c', `git diff --cached --numstat HEAD -- . ${ex}`], { cwd: ws });
  let files = 0, added = 0, removed = 0;
  for (const l of d.out.split('\n').filter(Boolean)) { const [x, y] = l.split('\t'); if (x === '-') continue; files++; added += +x; removed += +y; }
  return { filesChanged: files, linesAdded: added, linesRemoved: removed };
}
const PACKAGE = { sinter: '@tiaforge-ui/sinter', astro: 'astro', sveltekit: '@sveltejs/kit' };
/** Whether the project depends on the framework it was asked to use (a hand-rolled app scores, but is flagged). */
function usesFramework(ws, framework) {
  try { const p = JSON.parse(readFileSync(join(ws, 'package.json'), 'utf8')); return !!({ ...p.dependencies, ...p.devDependencies })[PACKAGE[framework]]; } catch { return false; }
}

async function grade(job, r) {
  await killPorts([r.PORT, r.API_PORT]);
  const g = await run('node', [join(here, TASKS[job.task].dir, 'grader/grade.mjs'), r.ws], { env: { PREVIEW_PORT: String(r.PORT), API_PORT: String(r.API_PORT) }, timeout: 900_000 });
  let grade; try { grade = JSON.parse(g.out.slice(g.out.indexOf('{'))); } catch { grade = { error: g.out.slice(-2000), passed: 0, total: null, checks: [] }; }
  writeFileSync(join(r.dir, 'grade.json'), JSON.stringify(grade, null, 2));
  await killPorts([r.PORT, r.API_PORT]);
  return grade;
}

const rows = existsSync(join(out, 'results.json')) ? JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')) : [];
const done = new Set(rows.map((x) => x.id));
const queue = jobs.filter((j) => !done.has(j.id));
async function worker(slot) {
  while (queue.length) {
    const job = queue.shift();
    console.log(`[slot ${slot}] start ${job.id}`);
    let r;
    if (a['grade-only']) { const dir = join(out, job.id); r = { dir, ws: join(dir, 'workspace'), PORT: 4400 + slot, API_PORT: 3100 + slot, meta: JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) }; }
    else r = await agent(job, slot);
    const g = await grade(job, r);
    const row = { ...r.meta, ...(await sourceStats(r.ws)), usesFramework: usesFramework(r.ws, job.framework), build: g.build, served: g.served, passed: g.passed, total: g.total,
      failed: (g.checks ?? []).filter((c) => !c.pass).map((c) => c.name) };
    rows.push(row);
    writeFileSync(join(out, 'results.json'), JSON.stringify(rows, null, 2));
    console.log(`[slot ${slot}] done  ${job.id}: ${g.passed}/${g.total} $${row.costUSD?.toFixed(2)} ${row.seconds}s turns=${row.turns}${row.leaks?.length ? ' LEAK' : ''}`);
  }
}
await Promise.all(Array.from({ length: Number(a.slots) }, (_, i) => worker(i)));
console.log(`results: ${join(out, 'results.json')}`);
