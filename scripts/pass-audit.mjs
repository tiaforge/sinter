// The byte-identity check of stage 3 (docs/proposals/redesign-notes/stage3-one-pass.md): each app below is built twice
// with this checkout's dist/, with a template's entries' second passes from the kept expansion off (`SN_ONE_PASS=0`,
// each parses and expands the page again) and on, each build in a process of its own, and the two `dist/` trees are
// compared file by file.
//
//   npm run build && node scripts/pass-audit.mjs          all apps; exits 1 on a difference, naming the files
//   node scripts/pass-audit.mjs --only bench-static       one app (repeatable, or a comma list)
//   node scripts/pass-audit.mjs --keep <dir>              keep both builds in <dir>/<app>/{off,on}/, to diff by hand
//   node scripts/pass-audit.mjs --switch SN_LATE_DESCRIBE another route's switch instead of `SN_ONE_PASS` (0 off, 1 on)
//   node scripts/pass-audit.mjs --canon                   both builds in the canonical numbering (`SN_CANON=1`)
//
// Each line gives both builds' times and, with the route on, which route each second pass took (`SN_PASS_LOG=1`).
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const BENCH = (name, o) => ({ root: `bench/astro/out/sinter-${name}-100`, bench: o });
const APPS = {
  'bench-static': BENCH('static', { n: 100 }),
  'bench-live': BENCH('live', { n: 100, live: true }),
  'bench-static-files': BENCH('static-files', { n: 100, files: true }),
  'bench-live-files': BENCH('live-files', { n: 100, files: true, live: true }),
  'bench-static-typecheck': BENCH('static-typecheck', { n: 100, typecheck: true }),
  'static-site': { root: 'examples/static-site' },
  'multilingual-site': { root: 'examples/multilingual-site' },
  dashboard: { root: 'examples/dashboard' },
  realworld: { root: 'examples/realworld', markdown: true },
};

const args = process.argv.slice(2);
const values = (k) => args.flatMap((a, i) => (args[i - 1] === k ? a.split(',') : []));

// a child: one build of one app into a folder, its time and the pass log on stderr
if (args[0] === '--child') {
  const [, name, outDir] = args;
  const { build } = await import('vite');
  const root = join(REPO, APPS[name].root);
  const t0 = performance.now();
  await build({ root, logLevel: 'silent', configFile: join(root, 'vite.config.js'), build: { outDir, emptyOutDir: true } });
  console.log(JSON.stringify({ ms: Math.round(performance.now() - t0) }));
  process.exit(0);
}

const only = values('--only');
const SWITCH = values('--switch')[0] ?? 'SN_ONE_PASS';
const CANON = args.includes('--canon');
const keep = values('--keep')[0];
for (const n of only) if (!APPS[n]) throw new Error(`pass-audit: no app \`${n}\`; the apps are ${Object.keys(APPS).join(', ')}`);
if (!existsSync(join(REPO, 'dist/vite.js'))) throw new Error('pass-audit: no dist/; run `npm run build` first');

/** a link `<dir>/node_modules/<name>` to `target`, unless the app has its own install there */
function link(dir, name, target) {
  const at = join(dir, 'node_modules', name);
  try { lstatSync(at); return; } catch { /* not there */ }
  mkdirSync(dirname(at), { recursive: true });
  symlinkSync(target, at, 'dir');
}
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));

function buildOnce(name, outDir, render) {
  const r = spawnSync(process.execPath, [import.meta.filename, '--child', name, outDir], {
    cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26,
    env: { ...process.env, [SWITCH]: render ? '1' : '0', SN_PASS_LOG: '1', SN_FROM_WALK_LOG: '1', SN_ONE_PASS_AUDIT: '', SN_DESCRIBE_AUDIT: '', SN_FROM_WALK_AUDIT: '', ...(CANON ? { SN_CANON: '1' } : {}) },
  });
  if (r.status !== 0) throw new Error(`pass-audit: ${name} (${SWITCH} ${render ? 'on' : 'off'}) failed:\n${r.stderr}\n${r.stdout}`);
  const ms = JSON.parse(r.stdout.trim().split('\n').at(-1)).ms;
  const log = [...r.stderr.matchAll(/^sinter (?:passes|descriptions|from walk): .*$/gm)].map((m) => m[0].replace(/^sinter passes: /, '')).join('\n  ');
  return { ms, log };
}

let failed = false;
for (const [name, app] of Object.entries(APPS)) {
  if (only.length && !only.includes(name)) continue;
  const root = join(REPO, app.root);
  if (app.bench && !existsSync(root)) (await import(join(REPO, 'bench/astro/sinter-app.mjs'))).writeSinterApp(root, app.bench);
  link(root, '@tiaforge-ui/sinter', REPO);
  if (app.markdown) {
    link(root, '@tiaforge-ui/sinter-markdown', join(REPO, 'packages/sinter-markdown'));
    link(join(REPO, 'packages/sinter-markdown'), '@tiaforge-ui/sinter', REPO);
  }
  const base = keep ? join(resolve(keep), name) : mkdtempSync(join(tmpdir(), `sinter-pass-audit-${name}-`));
  const off = join(base, 'off'), on = join(base, 'on');
  try {
    const a = buildOnce(name, off, false), b = buildOnce(name, on, true);
    const fa = walk(off).map((f) => relative(off, f)).sort(), fb = walk(on).map((f) => relative(on, f)).sort();
    const diff = [];
    for (const f of new Set([...fa, ...fb])) {
      if (!fa.includes(f)) { diff.push(`  only with the route  ${f}`); continue; }
      if (!fb.includes(f)) { diff.push(`  only without         ${f}`); continue; }
      const x = readFileSync(join(off, f)), y = readFileSync(join(on, f));
      if (x.equals(y)) continue;
      let i = 0;
      while (x[i] === y[i]) i++;
      diff.push(`  differs  ${f} at byte ${i}:\n    off ${JSON.stringify(x.subarray(Math.max(0, i - 80), i + 80).toString())}\n    on  ${JSON.stringify(y.subarray(Math.max(0, i - 80), i + 80).toString())}`);
    }
    const head = `${name.padEnd(19)} off ${String(a.ms).padStart(6)} ms, on ${String(b.ms).padStart(6)} ms, ${fa.length} files`;
    if (diff.length) { failed = true; console.log(`${head}: DIFFERENT\n${diff.slice(0, 20).join('\n')}${diff.length > 20 ? `\n  … ${diff.length - 20} more` : ''}`); }
    else console.log(`${head}: same`);
    if (b.log) console.log(`  ${b.log}`);
  } finally {
    if (!keep) rmSync(base, { recursive: true, force: true });
  }
}
if (failed) process.exit(1);
