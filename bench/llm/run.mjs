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
  out: { type: 'string' }, registry: { type: 'string' }, note: { type: 'string' }, 'slot-base': { type: 'string', default: '0' }, bases: { type: 'string', default: '/tmp/llmbench/bases' }, 'grade-only': { type: 'boolean', default: false },
} });

const MODELS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
// How each framework is named in the prompt: what a developer would type. sinter is new, so its npm package is named
// as well (the others are found by name alone); nothing else differs between the frameworks' prompts.
const FRAMEWORKS = {
  sinter: { name: 'sinter (the npm package `@tiaforge-ui/sinter`)', short: 'sinter' },
  astro: { name: 'Astro', short: 'Astro' },
  sveltekit: { name: 'SvelteKit', short: 'SvelteKit' },
};
const TASKS = {
  t1: { dir: 'tasks/t1-incidents', workspace: 'tasks/t1-incidents/workspace' },
  t4: { dir: 'tasks/t4-ops', workspace: 'tasks/t4-ops/workspace' },
  t5: { dir: 'tasks/t5-content-i18n', workspace: 'tasks/t5-content-i18n/workspace' },
  t2: { dir: 'tasks/t2-realworld', base: true }, // starts from <bases>/<framework> (setup.mjs); no Astro base exists
  t3: { dir: 'tasks/t3-content', workspace: 'tasks/t3-content/workspace' },
};
// Conditions (SPEC.md § Conditions). cold: no docs given, web tools allowed: an agent as people use it today.
// cold: no help, web tools on (what people get today). offline: no help, no web: what the model knows plus what the
// installed packages carry. docs: offline, plus the framework's documentation under the same cap (docs/fetch.mjs) in
// framework-docs/, named in one identical line of the prompt. tools: offline, plus the vendor's recommended setup for
// coding agents (tools/, MCP below), with nothing added to the prompt.
const LOCAL = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite'];
const CONDITIONS = {
  cold: { tools: [...LOCAL, 'WebFetch', 'WebSearch'] },
  offline: { tools: LOCAL },
  docs: { tools: LOCAL, docs: true },
  tools: { tools: LOCAL, vendor: true },
};
// What each vendor recommends for coding agents (SPEC.md § Conditions): Astro's "Build with AI" guide, the Docs MCP
// server; Svelte's AI docs, its MCP server and its AGENTS.md (tools/sveltekit.md); sinter, its starter template's agent
// notes (tools/sinter.md: llms.txt and `sinter check`). The instructions go in the project's CLAUDE.md.
const VENDOR = {
  astro: { mcp: { 'astro-docs': { type: 'http', url: 'https://mcp.docs.astro.build/mcp' } } },
  sveltekit: { mcp: { svelte: { type: 'http', url: 'https://mcp.svelte.dev/mcp' } }, instructions: 'tools/sveltekit.md' },
  sinter: { instructions: 'tools/sinter.md' },
};

// --registry: agents and graders install from there (registry.mjs serves an unpublished build); --note goes in each meta.json
if (a.registry) process.env.NPM_CONFIG_REGISTRY = a.registry;
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
  const PORT = 4400 + Number(a['slot-base']) + slot, API_PORT = 3100 + Number(a['slot-base']) + slot; // --slot-base: a second run.mjs beside this one
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const T = TASKS[job.task];
  if (T.base) cpSync(join(a.bases, job.framework), ws, { recursive: true });
  else cpSync(join(here, T.workspace), ws, { recursive: true });
  for (const f of ['api/server.mjs', 'api/API.md']) if (existsSync(join(ws, f))) writeFileSync(join(ws, f), readFileSync(join(ws, f), 'utf8').replaceAll('3001', String(API_PORT)));
  if (!existsSync(join(ws, '.git'))) await run('sh', ['-c', 'git init -q && git add -A && git -c user.name=bench -c user.email=bench@localhost commit -qm base --allow-empty'], { cwd: ws });
  const prompt = readFileSync(join(here, T.dir, 'PROMPT.md'), 'utf8')
    .replaceAll('{{FRAMEWORK}}', FRAMEWORKS[job.framework].name).replaceAll('{{PORT}}', String(PORT)).replaceAll('{{API_PORT}}', String(API_PORT));
  let prompt2 = prompt;
  const extraTools = [], extraArgs = [];
  if (cond.docs && existsSync(join(here, 'docs', `${job.framework}.txt`))) { // a framework that publishes no LLM docs gets none (Astro)
    mkdirSync(join(ws, 'framework-docs'), { recursive: true });
    cpSync(join(here, 'docs', `${job.framework}.txt`), join(ws, 'framework-docs', `${job.framework}.txt`));
    prompt2 += `\nThe ${FRAMEWORKS[job.framework].short} documentation is in \`framework-docs/${job.framework}.txt\`. Read what you need from it before you start.\n`;
  }
  if (cond.vendor) {
    const v = VENDOR[job.framework];
    if (v.instructions) { const f = join(ws, 'CLAUDE.md'); writeFileSync(f, (existsSync(f) ? readFileSync(f, 'utf8') + '\n' : '') + readFileSync(join(here, v.instructions), 'utf8')); }
    if (v.mcp) {
      writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: v.mcp }, null, 2));
      extraArgs.push('--mcp-config', join(dir, 'mcp.json'));
      extraTools.push(...Object.keys(v.mcp).map((n) => `mcp__${n}`));
    }
  }
  // what the condition added is part of the start, not of the agent's work
  await run('sh', ['-c', 'git add -A && git -c user.name=bench -c user.email=bench@localhost commit -qm condition || true'], { cwd: ws });
  writeFileSync(join(dir, 'prompt.md'), prompt2);
  mkdirSync(join(dir, 'tmp'));
  // its own npm cache too: npx keeps `npm create` starters there by name and version, and branch builds share a version
  const env = { ...process.env, TMPDIR: join(dir, 'tmp'), npm_config_cache: join(dir, 'npm-cache') };
  for (const k of Object.keys(env)) if (/^CLAUDE_(CODE_)?ADDITIONAL_DIRECTORIES/.test(k)) delete env[k];
  // the prompt goes in on stdin: in argv it would match the agents' own `pgrep -f api/server.mjs`, and they kill claude
  const args = ['-p', '--model', MODELS[job.model], '--output-format', 'stream-json', '--verbose',
    '--allowedTools', [...cond.tools, ...extraTools].join(' '), '--disallowedTools', 'Agent Task',
    '--setting-sources', 'project', '--strict-mcp-config', ...extraArgs, '--no-session-persistence', '--max-budget-usd', a.budget];
  const t0 = Date.now();
  const res = await new Promise((resolve) => {
    // its own PID namespace: agents clean up with `pkill -f "vite preview"` and the like, which would otherwise kill
    // other slots' servers (and their agents); the network and the file system are shared
    const p = spawn('unshare', ['--pid', '--fork', '--mount-proc', 'claude', ...args], { cwd: ws, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    p.stdin.end(prompt2);
    const chunks = []; let err = '';
    p.stdout.on('data', (d) => chunks.push(d)); p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch {} }, Number(a.timeout) * 60_000);
    p.on('close', (code) => { clearTimeout(timer); try { process.kill(-p.pid, 'SIGKILL'); } catch {} resolve({ code, stdout: Buffer.concat(chunks).toString(), stderr: err }); });
  });
  writeFileSync(join(dir, 'transcript.jsonl'), res.stdout);
  await killPorts([PORT, API_PORT]); // anything the agent left on its ports (its process group is killed above)
  const meta = { ...job, slot, PORT, API_PORT, condition: a.condition, parallelSlots: Number(a.slots), // Lighthouse beside other runs: compare its timings with care
    registry: a.registry ?? null, note: a.note ?? null, exit: res.code, seconds: Math.round((Date.now() - t0) / 1000), stderr: res.stderr.slice(-2000), ...transcriptStats(res.stdout) };
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
  const docReads = inputs.filter((s) => /llms(-full|-small)?\.txt|framework-docs\/|AGENTS\.md|node_modules\/[^"]*\/(docs?|README)/i.test(s)).length;
  const mcpCalls = uses.filter((u) => u.name.startsWith('mcp__')).length;
  const builds = uses.filter((u) => u.name === 'Bash' && /\b(npm run (build|check)|vite build|astro (build|check)|svelte-check|sinter check)\b/.test(u.input?.command ?? '')).length;
  // the agent must not see this repository (examples/realworld would be an answer key): any path into it is flagged
  const leaks = inputs.filter((s) => /\/home\/user\b|tiaforge\/sinter\/(tree|blob)\/[^"]*examples/.test(s)).slice(0, 5);
  return {
    costUSD: result.total_cost_usd ?? null, turns: result.num_turns ?? null, apiSeconds: result.duration_api_ms ? Math.round(result.duration_api_ms / 1000) : null,
    outputTokens: result.usage?.output_tokens ?? null, resultSubtype: result.subtype ?? null, toolCalls: uses.length, tools,
    webFetches: urls, webSearches: searches, docReads, mcpCalls, buildRuns: builds, leaks,
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
  const g = await run('unshare', ['--pid', '--fork', '--mount-proc', 'node', join(here, TASKS[job.task].dir, 'grader/grade.mjs'), r.ws], { env: { PREVIEW_PORT: String(r.PORT), API_PORT: String(r.API_PORT), npm_config_cache: join(r.dir, 'npm-cache-grade') }, timeout: 900_000 });
  let grade; try { grade = JSON.parse(g.out.slice(g.out.indexOf('{'))); } catch { grade = { error: g.out.slice(-2000), passed: 0, total: null, checks: [] }; }
  writeFileSync(join(r.dir, 'grade.json'), JSON.stringify(grade, null, 2));
  await killPorts([r.PORT, r.API_PORT]);
  return grade;
}

// --grade-only regrades every run from scratch (results-regraded.json); otherwise finished runs are skipped
const resultsFile = join(out, a['grade-only'] ? 'results-regraded.json' : 'results.json');
const rows = !a['grade-only'] && existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, 'utf8')) : [];
const done = new Set(rows.map((x) => x.id));
const queue = jobs.filter((j) => !done.has(j.id) && (!a['grade-only'] || existsSync(join(out, j.id, 'meta.json'))));
async function worker(slot) {
  while (queue.length) {
    const job = queue.shift();
    console.log(`[slot ${slot}] start ${job.id}`);
    let r;
    if (a['grade-only']) { const dir = join(out, job.id); const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')); r = { dir, ws: join(dir, 'workspace'), PORT: meta.PORT, API_PORT: meta.API_PORT, meta }; } // the ports the app was built for
    else r = await agent(job, slot);
    const g = await grade(job, r);
    const row = { ...r.meta, ...(await sourceStats(r.ws)), usesFramework: usesFramework(r.ws, job.framework), build: g.build, served: g.served, passed: g.passed, total: g.total,
      failed: (g.checks ?? []).filter((c) => !c.pass).map((c) => c.name), measure: g.measure,
      measuredAlone: Number(a.slots) === 1 }; // sizes do not depend on load, Lighthouse timings do
    rows.push(row);
    writeFileSync(resultsFile, JSON.stringify(rows, null, 2));
    console.log(`[slot ${slot}] done  ${job.id}: ${g.passed}/${g.total} $${row.costUSD?.toFixed(2)} ${row.seconds}s turns=${row.turns}${row.leaks?.length ? ' LEAK' : ''}`);
  }
}
await Promise.all(Array.from({ length: Number(a.slots) }, (_, i) => worker(i)));
console.log(`results: ${resultsFile}`);
