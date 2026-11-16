// Spike (docs/proposals/parallel-build.md): the benchmark's app built with 0 (the main thread), 1, 2 and 3 compile
// workers, each build in a fresh process; every build's dist/ is compared with the first's, byte for byte.
// node bench/collections/workers.mjs [--sizes 1000,4000] [--workers 0,1,2,3] [--live]
import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeApp } from './app.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const sizes = arg('--sizes', '1000').split(',').map(Number);
const counts = arg('--workers', '0,1,2,3').split(',').map(Number);
const live = process.argv.includes('--live');
const out = resolve(import.meta.dirname, 'out');
const rows = [];
for (const n of sizes) {
  const root = join(out, `workers-${live ? 'live' : 'static'}-${n}`), first = `${root}-dist`;
  writeApp(root, { n, live });
  rmSync(first, { recursive: true, force: true });
  let base = null;
  for (const w of counts) {
    const stats = join(out, `stats-${n}-${w}.log`);
    rmSync(stats, { force: true });
    const r = JSON.parse(execFileSync(process.execPath, [join(import.meta.dirname, 'run.mjs'), root], { encoding: 'utf8', maxBuffer: 1 << 26, env: { ...process.env, SINTER_WORKERS: String(w), SINTER_WORKERS_STATS: stats } }).trim().split('\n').pop());
    let same = 'first';
    if (base === null) { cpSync(join(root, 'dist'), first, { recursive: true }); base = r.ms; }
    else { try { execFileSync('diff', ['-rq', first, join(root, 'dist')]); same = 'identical'; } catch { same = 'DIFFERENT'; } }
    let pool = '';
    try { pool = readFileSync(stats, 'utf8').trim().replace(/\n/g, ' | '); } catch { /* no workers */ }
    rows.push({ n, workers: w, ms: r.ms, maxRssMb: r.maxRssMb, speedup: +(base / r.ms).toFixed(2), error: r.error, dist: same, pool });
    console.log(JSON.stringify(rows.at(-1)));
  }
}
console.table(rows.map(({ pool, error, ...r }) => r));
