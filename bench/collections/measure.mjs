// The prototype's measurements (docs/proposals/collections.md, part 0): builds the app at each size, static and
// with a live resource, each build in a fresh process. node bench/collections/measure.mjs [--sizes 10,100,1000,10000]
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { writeApp } from './app.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const sizes = arg('--sizes', '10,100,1000,10000').split(',').map(Number);
const out = resolve(import.meta.dirname, 'out');
const rows = [];
for (const live of [false, true]) for (const n of sizes) {
  const root = join(out, `${live ? 'live' : 'static'}-${n}`);
  writeApp(root, { n, live });
  const r = JSON.parse(execFileSync(process.execPath, ['--max-old-space-size=12000', join(import.meta.dirname, 'run.mjs'), root], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim().split('\n').pop());
  rows.push({ page: live ? 'live' : 'static', n, ...r, msPerEntry: +(r.ms / n).toFixed(1) });
  console.log(JSON.stringify(rows.at(-1)));
}
console.table(rows.map(({ error, ...r }) => r));
