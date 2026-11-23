// What pages embed of their build-time data, before and after a change (docs/proposals/redesign-notes/embed-fields.md):
// each app below is built with another checkout's dist/ (`--before`, its commit built there) and with this one's, each
// build in a process of its own, and the two `dist/` trees are compared. A file that differs must be a page that
// embedded build-time data (a `<script type="application/json" data-sn>` before) or its page module, and every
// embedded value after must be a subset of the one before (the same id, fewer keys at some depth, nothing else);
// any other file that differs fails. Prints a table of each changed page: its bytes, its JSON scripts' bytes, whether it
// still has one, and its module's bytes, before and after.
//
//   npm run build && node scripts/embed-audit.mjs --before <checkout with dist/>     all apps; exits 1 on a failure
//   node scripts/embed-audit.mjs --before <dir> --only bench-live                   one app (repeatable, or a comma list)
//   node scripts/embed-audit.mjs --before <dir> --app mail=<path to an app>          another app, by its folder
//   node scripts/embed-audit.mjs --compare <name> <dist before> <dist after>          two builds made elsewhere (sinter-mail's
//                                                                                    audit pages: `mail-audit.mjs --keep`)
//
// What may differ in a changed page besides its JSON scripts is printed as a note: a value written into the code can
// make a live resource's URL a constant, which the page may then request early.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const BENCH = (o) => ({ bench: o });
const APPS = {
  'bench-static': BENCH({ n: 100 }),
  'bench-live': BENCH({ n: 100, live: true }),
  'bench-static-files': BENCH({ n: 100, files: true }),
  'bench-live-files': BENCH({ n: 100, files: true, live: true }),
  'static-site': { root: 'examples/static-site' },
  'multilingual-site': { root: 'examples/multilingual-site' },
  dashboard: { root: 'examples/dashboard' },
  realworld: { root: 'examples/realworld' },
};

const args = process.argv.slice(2);
const values = (k) => args.flatMap((a, i) => (args[i - 1] === k ? a.split(',') : []));

if (args[0] === '--child') {
  const [, root, outDir] = args;
  const { build } = await import('vite');
  const t0 = performance.now();
  await build({ root, logLevel: 'silent', configFile: join(root, 'vite.config.js'), build: { outDir, emptyOutDir: true } });
  console.log(JSON.stringify({ ms: Math.round(performance.now() - t0) }));
  process.exit(0);
}

const before = values('--before')[0] && resolve(values('--before')[0]);
if (!args.includes('--compare') && (!before || !existsSync(join(before, 'dist/vite.js')))) throw new Error('embed-audit: --before <a checkout with dist/ built>');
if (!existsSync(join(REPO, 'dist/vite.js'))) throw new Error('embed-audit: no dist/; run `npm run build` first');
for (const a of values('--app')) { const [k, p] = a.split('='); APPS[k] = { root: resolve(p), outside: true }; }
const only = values('--only');

const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const link = (at, target) => { rmSync(at, { recursive: true, force: true }); mkdirSync(dirname(at), { recursive: true }); symlinkSync(target, at, 'dir'); };

/** the app copied into `dir`, its sinter (and sinter-markdown) that of `checkout` */
async function place(name, app, dir, checkout) {
  if (app.bench) {
    (await import(join(REPO, 'bench/astro/sinter-app.mjs'))).writeSinterApp(dir, app.bench);
  } else {
    const src = app.outside ? app.root : join(REPO, app.root);
    cpSync(src, dir, { recursive: true, filter: (f) => !/[\\/](node_modules|dist|\.git)$/.test(f) });
    if (existsSync(join(src, 'node_modules'))) for (const e of readdirSync(join(src, 'node_modules'))) {
      if (e === '@tiaforge-ui' || e === '.cache' || e === '.vite') continue;
      mkdirSync(join(dir, 'node_modules'), { recursive: true });
      symlinkSync(join(src, 'node_modules', e), join(dir, 'node_modules', e));
    }
  }
  // a package of its own: under this checkout, `@tiaforge-ui/sinter` would otherwise be this package's own name
  if (!existsSync(join(dir, 'package.json'))) writeFileSync(join(dir, 'package.json'), '{ "name": "embed-audit-app", "private": true, "type": "module" }\n');
  link(join(dir, 'node_modules/@tiaforge-ui/sinter'), checkout);
  link(join(dir, 'node_modules/@tiaforge-ui/sinter-markdown'), join(checkout, 'packages/sinter-markdown'));
}

function buildOnce(root, outDir) {
  const r = spawnSync(process.execPath, [import.meta.filename, '--child', root, outDir], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`embed-audit: ${root} failed:\n${r.stderr}\n${r.stdout}`);
  return JSON.parse(r.stdout.trim().split('\n').at(-1)).ms;
}

/** a built file's name without its content hash (`assets/blog/post-1-AbC123.js` → `assets/blog/post-1.js`) */
const unhashed = (f) => f.replace(/-[\w-]{8}(\.\w+)$/, '$1');
const scripts = (html) => [...html.matchAll(/<script type="application\/json" data-sn="(\d+)">([\s\S]*?)<\/script>/g)].map((m) => ({ id: m[1], text: m[2], bytes: Buffer.byteLength(m[0]) }));
/** whether `a` is `b` with some keys of its objects left out, at any depth */
const subset = (a, b) => {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => subset(x, b[i]));
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  return Object.keys(a).every((k) => k in b && subset(a[k], b[k]));
};
const modules = (html) => [...html.matchAll(/<script type="module"[^>]*src="\/([^"]+)"/g)].map((m) => unhashed(m[1]));

let failed = false;
const rows = [];
const filesOf = (out) => new Map(walk(out).map((f) => relative(out, f)).map((f) => [unhashed(f), f]));

/** two builds of one app compared (`A` before, `B` after): what changed, the table's rows, and what may not change */
function compare(name, A, B) {
  const problems = [], notes = [], changed = [];
  for (const f of new Set([...A.files.keys(), ...B.files.keys()])) {
    const fa = A.files.get(f), fb = B.files.get(f);
    if (!fa || !fb) { problems.push(`only ${fa ? 'before' : 'after'}: ${f}`); continue; }
    if (readFileSync(join(A.out, fa)).equals(readFileSync(join(B.out, fb)))) continue;
    changed.push(f);
  }
  const pages = changed.filter((f) => f.endsWith('.html'));
  const explained = new Set();
  for (const f of pages) {
    const x = readFileSync(join(A.out, A.files.get(f)), 'utf8'), y = readFileSync(join(B.out, B.files.get(f)), 'utf8');
    const sa = scripts(x), sb = scripts(y);
    if (!sa.length) { problems.push(`${f}: changed, and embedded no build-time data before`); continue; }
    for (const s of sb) {
      const was = sa.find((t) => t.id === s.id);
      if (!was) { problems.push(`${f}: a JSON script after that was not there before (data-sn="${s.id}")`); continue; }
      if (!subset(JSON.parse(s.text), JSON.parse(was.text))) problems.push(`${f}: data-sn="${s.id}" after is not a subset of before`);
    }
    // the rest of the page, its JSON scripts and the hashed names it links to left out: a note where it differs
    // (a value written into the code can make a live resource's URL a constant, which the page then preloads)
    const strip = (h) => h.replace(/<script type="application\/json" data-sn="\d+">[\s\S]*?<\/script>/g, '').replace(/(\/[\w./-]+?)-[\w-]{8}(\.(?:js|css))/g, '$1$2').replace(/>\s+</g, '><');
    const px = strip(x), py = strip(y);
    if (px !== py) { let i = 0; while (px[i] === py[i]) i++; notes.push(`${f}: differs outside its JSON scripts at ${i}: ${JSON.stringify(px.slice(Math.max(0, i - 40), i + 80))} -> ${JSON.stringify(py.slice(Math.max(0, i - 40), i + 80))}`); }
    const ma = modules(x), mb = modules(y);
    const size = (S, m) => m.map((n) => (S.files.get(n) ? readFileSync(join(S.out, S.files.get(n))).length : 0)).reduce((a, b) => a + b, 0);
    // what the page loads (its module, its early file): changed with it
    for (const m of y.matchAll(/(?:src|href)="\/([^"]+\.js)"/g)) explained.add(unhashed(m[1]));
    rows.push({ app: name, page: f, html: [Buffer.byteLength(x), Buffer.byteLength(y)], json: [sa.reduce((a, s) => a + s.bytes, 0), sb.reduce((a, s) => a + s.bytes, 0)], present: [sa.length > 0, sb.length > 0], module: [size(A, ma), size(B, mb)] });
  }
  // a script a changed page loads may change with it; anything else may not
  for (const f of changed) if (!f.endsWith('.html') && !explained.has(f)) problems.push(`${f}: changed, and no changed page loads it`);
  const head = `${name.padEnd(19)} ${A.ms != null ? `before ${String(A.ms).padStart(6)} ms, after ${String(B.ms).padStart(6)} ms, ` : ''}${A.files.size} files, ${pages.length} pages changed`;
  if (problems.length) { failed = true; console.log(`${head}: FAILED\n${problems.slice(0, 20).map((p) => `  ${p}`).join('\n')}${problems.length > 20 ? `\n  … ${problems.length - 20} more` : ''}`); }
  else console.log(`${head}: ok`);
  for (const n of notes.slice(0, 3)) console.log(`  note: ${n}`);
  if (notes.length > 3) console.log(`  note: … ${notes.length - 3} more pages differ outside their JSON scripts`);
}

if (args.includes('--compare')) {
  const [name, a, b] = args.slice(args.indexOf('--compare') + 1);
  compare(name, { out: resolve(a), files: filesOf(resolve(a)) }, { out: resolve(b), files: filesOf(resolve(b)) });
} else for (const [name, app] of Object.entries(APPS)) {
  if (only.length && !only.includes(name)) continue;
  // (under the checkout, so the apps' imports resolve from its node_modules)
  mkdirSync(join(REPO, 'bench/astro/out'), { recursive: true });
  const base = mkdtempSync(join(REPO, 'bench/astro/out', `embed-audit-${name}-`));
  try {
    const side = {};
    for (const [k, checkout] of [['before', before], ['after', REPO]]) {
      const root = join(base, k, 'app'), out = join(base, k, 'dist');
      await place(name, app, root, checkout);
      side[k] = { out, ms: buildOnce(root, out), files: filesOf(out) };
    }
    compare(name, side.before, side.after);
  } finally {
    if (!args.includes('--keep')) rmSync(base, { recursive: true, force: true }); else console.log(`  kept in ${base}`);
  }
}

// the table: one row per changed page; a run of pages alike (a page per entry) as its first, its count and its totals
const groups = new Map();
for (const r of rows) {
  const k = `${r.app}\0${r.page.replace(/\d+/g, 'N')}`;
  const g = groups.get(k) ?? { ...r, n: 0, html: [0, 0], json: [0, 0], module: [0, 0], first: r };
  g.n++;
  for (const f of ['html', 'json', 'module']) { g[f][0] += r[f][0]; g[f][1] += r[f][1]; }
  groups.set(k, g);
}
if (groups.size) {
  console.log('\n| app | page | pages | HTML before | HTML after | JSON before | JSON after | JSON script after | module before | module after |');
  console.log('|---|---|---:|---:|---:|---:|---:|---|---:|---:|');
  for (const g of groups.values()) {
    const one = g.first, avg = (x) => Math.round(x / g.n);
    console.log(`| ${g.app} | ${g.n > 1 ? `${one.page} (each of ${g.n}, mean)` : one.page} | ${g.n} | ${avg(g.html[0])} | ${avg(g.html[1])} | ${avg(g.json[0])} | ${avg(g.json[1])} | ${one.present[1] ? 'yes' : 'no'} | ${avg(g.module[0])} | ${avg(g.module[1])} |`);
  }
}
if (failed) process.exit(1);
