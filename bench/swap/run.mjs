// Runs the swap benchmark in headless Chrome over the DevTools protocol (no dependencies) and
// prints markdown tables; raw samples go to results/<timestamp>.json.
//   CHROME=/path/to/chrome node run.mjs
// Environment: N=100,1000,5000  S=replace,update  ROUNDS=3  ITER=50  WARMUP=10  CPU=1 (throttling
// rate)  ONLY=sinter,htmx-4.0.1 (variant name substrings)
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { evaluate, launch, withPage } from './cdp.mjs';
import { start } from './server.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const env = (k, d) => process.env[k] ?? d;
const SIZES = env('N', '100,1000,5000').split(',').map(Number);
const SCENARIOS = env('S', 'replace,update').split(',');
const ROUNDS = +env('ROUNDS', 3), ITER = +env('ITER', 50), WARMUP = +env('WARMUP', 10), CPU = +env('CPU', 1);
const ONLY = process.env.ONLY?.split(',');

// name → page path and the files the browser loads for the library
const VARIANTS = [
  ['vanilla-html', '/vanilla-html.html', []],
  ['vanilla-json', '/vanilla-json.html', []],
  ['sinter', '/sinter/', ['dist/assets']],
  ['htmx-2.0.11', '/htmx-2.0.11.html', ['vendor/htmx-2.0.11.min.js']],
  ['htmx-4.0.1', '/htmx-4.0.1.html', ['vendor/htmx-4.0.1.min.js']],
  ['htmx-4.0.1-morph', '/htmx-4.0.1-morph.html', ['vendor/htmx-4.0.1.min.js']],
  ['datastar-1.0.4', '/datastar-1.0.4.html', ['vendor/datastar-1.0.4.js']],
  ['datastar-1.0.4-replace', '/datastar-1.0.4-replace.html', ['vendor/datastar-1.0.4.js']],
].filter(([name]) => !ONLY || ONLY.some((o) => name.includes(o)));

async function measure(chrome, url) {
  return withPage(chrome, url, (send) => evaluate(send, `window.__bench.run({ warmup: ${WARMUP}, iterations: ${ITER} })`), { cpu: CPU });
}

// ---- stats and tables

const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b), i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
const fmt = (x) => (x < 10 ? x.toFixed(2) : x < 100 ? x.toFixed(1) : x.toFixed(0));
const kb = (b) => (b / 1024).toFixed(1);
const gz = (buf) => gzipSync(buf, { level: 9 }).length;

function libBytes(files) {
  let raw = 0, z = 0;
  for (const f of files) {
    const p = join(here, f);
    const list = f === 'dist/assets' ? readdirSync(p).filter((x) => x.endsWith('.js') && !x.startsWith('harness')).map((x) => join(p, x)) : [p];
    for (const x of list) { const b = readFileSync(x); raw += b.length; z += gz(b); }
  }
  return { raw, gz: z };
}

// ---- main

// the sinter page bundles the harness: rebuild so it never runs a stale copy
if (spawnSync('npx', ['vite', 'build', '--logLevel', 'warn'], { cwd: here, stdio: 'inherit' }).status) process.exit(1);
const server = await start();
const chrome = await launch();
const samples = {}; // scenario → n → variant → { dom: [], layout: [] }
const shuffle = (xs) => xs.map((x) => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
const total = ROUNDS * SCENARIOS.length * SIZES.length * VARIANTS.length;
let done = 0;
try {
  for (let round = 0; round < ROUNDS; round++)
    for (const s of SCENARIOS) for (const n of SIZES) for (const [name, path] of shuffle(VARIANTS)) {
      process.stderr.write(`\r[${++done}/${total}] ${s} n=${n} ${name}`.padEnd(60));
      const r = await measure(chrome, `${server.url}${path}?n=${n}&s=${s}`);
      const slot = ((samples[s] ??= {})[n] ??= {})[name] ??= { dom: [], layout: [] };
      slot.dom.push(...r.dom); slot.layout.push(...r.layout);
    }
} finally {
  process.stderr.write('\n');
  await chrome.close().catch((e) => console.error(`cleanup: ${e.message}`));
  await server.close();
}

const out = [];
out.push(`Swap benchmark, ${new Date().toISOString().slice(0, 10)}: ${ROUNDS} rounds × ${ITER} swaps (after ${WARMUP} warm-up) per cell${CPU > 1 ? `, CPU throttled ${CPU}×` : ''}.`);
out.push('Median ms from click() to the expected rows in the DOM / to that DOM styled and laid out.\n');
for (const s of SCENARIOS) {
  out.push(`### ${s}\n`);
  out.push(`| variant | ${SIZES.map((n) => `${n} rows`).join(' | ')} |`);
  out.push(`| --- | ${SIZES.map(() => '---:').join(' | ')} |`);
  for (const [name] of VARIANTS)
    out.push(`| ${name} | ${SIZES.map((n) => { const x = samples[s][n][name]; return `${fmt(q(x.dom, 0.5))} / ${fmt(q(x.layout, 0.5))}`; }).join(' | ')} |`);
  out.push('');
}
const n0 = SIZES.includes(1000) ? 1000 : SIZES.at(-1);
const wire = (path) => { const b = Buffer.from(server.data(path, new URLSearchParams(`n=${n0}&s=replace&v=a`)).body); return `${kb(b.length)} KB (${kb(gz(b))} gz)`; };
out.push(`### Bytes\n`);
out.push(`Response for ${n0} rows: HTML fragment ${wire('/rows.html')}, JSON ${wire('/rows.json')}.\n`);
out.push('| variant | library JS (gz KB) |');
out.push('| --- | ---: |');
for (const [name, , files] of VARIANTS) out.push(`| ${name} | ${files.length ? kb(libBytes(files).gz) : '–'} |`);
console.log(out.join('\n'));

mkdirSync(join(here, 'results'), { recursive: true });
const file = join(here, 'results', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify({ date: new Date().toISOString(), sizes: SIZES, rounds: ROUNDS, iterations: ITER, warmup: WARMUP, cpu: CPU, samples }));
console.error(`samples: ${file}`);
