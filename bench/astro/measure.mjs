// Builds the same posts with sinter (this checkout's dist/) and with Astro, each build in a fresh process, and prints
// the wall time of each. node bench/astro/measure.mjs [--n 100] [--runs 3] [--only sinter|astro]   (README.md)
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeAstroApp } from './astro-app.mjs';
import { writeSinterApp } from './sinter-app.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const n = Number(arg('--n', '100'));
const runs = Number(arg('--runs', '3'));
const only = arg('--only', '');
const out = resolve(import.meta.dirname, 'out');
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const htmlIn = (d) => (existsSync(d) ? readdirSync(d, { recursive: true }).filter((f) => String(f).endsWith('.html')).length : 0);
const rows = [];

/** the wall time of one process, start to exit */
function timed(cmd, args, cwd) {
  const t = performance.now();
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' }, maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd}:\n${(r.stdout + r.stderr).slice(-2000)}`);
  return Math.round(performance.now() - t);
}

if (only !== 'astro') {
  const variants = { static: {}, live: { live: true }, 'static-files': { files: true }, 'live-files': { files: true, live: true }, 'static-typecheck': { typecheck: true } };
  for (const [name, o] of Object.entries(variants)) {
    const root = join(out, `sinter-${name}-${n}`);
    writeSinterApp(root, { n, ...o });
    const ms = Array.from({ length: runs }, () => timed(process.execPath, [join(import.meta.dirname, 'run-sinter.mjs'), root], root));
    rows.push({ site: `sinter, ${name}`, pages: htmlIn(join(root, 'dist')), ms: median(ms), runs: ms.join(' ') });
    console.log(JSON.stringify(rows.at(-1)));
  }
}
if (only !== 'sinter') {
  const root = join(out, `astro-${n}`);
  writeAstroApp(root, { n });
  if (!existsSync(join(root, 'node_modules/astro'))) execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' });
  const cold = () => { for (const d of ['dist', '.astro', 'node_modules/.astro', 'node_modules/.vite']) rmSync(join(root, d), { recursive: true, force: true }); };
  const ms = Array.from({ length: runs }, () => (cold(), timed(process.execPath, [join(root, 'node_modules/astro/bin/astro.mjs'), 'build'], root)));
  rows.push({ site: 'astro, cold', pages: htmlIn(join(root, 'dist')), ms: median(ms), runs: ms.join(' ') });
  console.log(JSON.stringify(rows.at(-1)));
}
console.table(rows);
