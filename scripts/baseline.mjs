// The byte-for-byte baseline of docs/proposals/axes.md (step 0): builds each app below with this checkout's dist/
// and compares every emitted file with the recorded hashes in test/baseline/<app>.json, so a refactor that must not
// change the output can show it does not.
//
//   npm run build && node scripts/baseline.mjs            compare; exits 1 on a difference, naming the files
//   node scripts/baseline.mjs --record                    record the current output as the baseline
//   node scripts/baseline.mjs --keep <dir>                also keep each build in <dir>/<app>/, to diff by hand
//   node scripts/baseline.mjs --only multilingual-site    one app (repeatable, or a comma list)
//
// Each app resolves `@tiaforge-ui/sinter` (and sinter-markdown) through a link to this checkout, as `file:../..` does;
// the links are made in the app's node_modules when it has none.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { build } from 'vite';

const REPO = resolve(import.meta.dirname, '..');
const RECORDS = join(REPO, 'test/baseline');

/** the apps, each a root and how it is built: its own vite.config.js, or the plugin with the options its test uses */
const APPS = {
  'multilingual-site': { root: 'examples/multilingual-site' },
  'static-site': { root: 'examples/static-site' },
  realworld: { root: 'examples/realworld', markdown: true },
  dashboard: { root: 'examples/dashboard' },
  'swap-csp': { root: 'e2e/swap-csp' },
  'vite-i18n': { root: 'test/fixtures/vite-i18n', options: { typecheck: true } },
  // bench/axes's app, small: plain pages and a page per entry (`{$locale}` lists) in two languages, one layout
  axes: { generate: { pages: 3, posts: 2, langs: 2 } },
};

const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const values = (k) => args.flatMap((a, i) => (args[i - 1] === k ? a.split(',') : []));
const only = values('--only');
const keep = values('--keep')[0];
const record = flag('--record');
for (const n of only) if (!APPS[n]) throw new Error(`baseline: no app \`${n}\`; the apps are ${Object.keys(APPS).join(', ')}`);
if (!existsSync(join(REPO, 'dist/vite.js'))) throw new Error('baseline: no dist/; run `npm run build` first');

/** a link `<dir>/node_modules/<name>` to `target`, unless the app has its own install there */
function link(dir, name, target) {
  const at = join(dir, 'node_modules', name);
  try { lstatSync(at); return; } catch { /* not there */ }
  mkdirSync(dirname(at), { recursive: true });
  symlinkSync(target, at, 'dir');
}

const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** builds one app into a fresh folder and returns { file: { sha256, bytes } }, sorted by path */
async function buildApp(name, app) {
  let root = app.root && join(REPO, app.root);
  if (app.generate) {
    // inside the repository, so its config resolves vite (bench/axes/out/ is ignored by git)
    root = join(REPO, 'bench/axes/out', `baseline-${name}`);
    (await import(join(REPO, 'bench/axes/app.mjs'))).writeApp(root, app.generate);
  }
  link(root, '@tiaforge-ui/sinter', REPO);
  if (app.markdown) {
    link(root, '@tiaforge-ui/sinter-markdown', join(REPO, 'packages/sinter-markdown'));
    link(join(REPO, 'packages/sinter-markdown'), '@tiaforge-ui/sinter', REPO);
  }
  const outDir = keep ? join(resolve(keep), name) : mkdtempSync(join(tmpdir(), `sinter-baseline-${name}-`));
  const config = app.options
    ? { configFile: false, plugins: [(await import(join(REPO, 'dist/vite.js'))).default(app.options)] }
    : { configFile: join(root, 'vite.config.js') };
  const t0 = performance.now();
  try {
    await build({ root, logLevel: 'silent', ...config, build: { outDir, emptyOutDir: true } });
    const files = {};
    for (const f of walk(outDir).sort()) {
      const b = readFileSync(f);
      files[relative(outDir, f).split('\\').join('/')] = { sha256: sha(b), bytes: b.length };
    }
    return { files, ms: Math.round(performance.now() - t0) };
  } finally {
    if (!keep) rmSync(outDir, { recursive: true, force: true });
    if (app.generate) rmSync(root, { recursive: true, force: true });
  }
}

let failed = false;
mkdirSync(RECORDS, { recursive: true });
for (const [name, app] of Object.entries(APPS)) {
  if (only.length && !only.includes(name)) continue;
  const { files, ms } = await buildApp(name, app);
  const at = join(RECORDS, `${name}.json`);
  const count = Object.keys(files).length;
  if (record) {
    writeFileSync(at, `${JSON.stringify(files, null, 1)}\n`);
    console.log(`${name.padEnd(18)} recorded ${count} files (${ms} ms)`);
    continue;
  }
  if (!existsSync(at)) { failed = true; console.log(`${name.padEnd(18)} no baseline: run with --record`); continue; }
  const was = JSON.parse(readFileSync(at, 'utf8'));
  const changed = Object.keys(files).filter((f) => was[f] && was[f].sha256 !== files[f].sha256);
  const added = Object.keys(files).filter((f) => !was[f]);
  const removed = Object.keys(was).filter((f) => !files[f]);
  if (!changed.length && !added.length && !removed.length) { console.log(`${name.padEnd(18)} same, ${count} files (${ms} ms)`); continue; }
  failed = true;
  console.log(`${name.padEnd(18)} DIFFERENT (${ms} ms)`);
  for (const f of changed) console.log(`  changed  ${f}  ${was[f].bytes} → ${files[f].bytes} B`);
  for (const f of added) console.log(`  added    ${f}`);
  for (const f of removed) console.log(`  removed  ${f}`);
}
if (failed && !record) {
  console.log('\nTo see a change: --keep <dir> on this checkout and on the baseline\'s commit, then diff the two folders.');
  process.exit(1);
}
