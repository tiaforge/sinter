// node ident.mjs <repo> <outdir> [apps...]  builds each app with <repo>'s dist into <outdir>/<app>
// node ident.mjs --cmp <a> <b>              compares two such trees
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const a = process.argv.slice(2);
if (a[0] === '--cmp') {
  const [x, y] = [resolve(a[1]), resolve(a[2])];
  const fx = walk(x).map((f) => relative(x, f)).sort(), fy = walk(y).map((f) => relative(y, f)).sort();
  let bad = 0;
  for (const f of new Set([...fx, ...fy])) {
    if (!fx.includes(f) || !fy.includes(f)) { bad++; console.log('only in one', f); continue; }
    const p = readFileSync(join(x, f)), q = readFileSync(join(y, f));
    if (!p.equals(q)) { bad++; let i = 0; while (p[i] === q[i]) i++; if (bad < 10) console.log('differs', f, 'at', i, '\n  ', JSON.stringify(p.subarray(Math.max(0,i-80), i+80).toString()), '\n  ', JSON.stringify(q.subarray(Math.max(0,i-80), i+80).toString())); }
  }
  console.log(`${fx.length} files, ${bad} differ`); process.exit(bad ? 1 : 0);
}
if (a[0] === '--child') {
  const [, root, out] = a;
  const { build } = await import(join(process.cwd(), 'node_modules/vite/dist/node/index.js'));
  await build({ root, logLevel: 'silent', configFile: join(root, 'vite.config.js'), build: { outDir: out, emptyOutDir: true } });
  process.exit(0);
}
const REPO = resolve(a[0]), OUT = resolve(a[1]);
const B = (o) => ({ bench: o });
const APPS = {
  'static': B({ n: 100 }), 'live': B({ n: 100, live: true }), 'static-files': B({ n: 100, files: true }),
  'live-files': B({ n: 100, files: true, live: true }), 'static-typecheck': B({ n: 100, typecheck: true }),
  'static-site': { root: 'examples/static-site' }, 'multilingual-site': { root: 'examples/multilingual-site' },
  dashboard: { root: 'examples/dashboard' }, realworld: { root: 'examples/realworld', markdown: true },
};
function link(dir, name, target) { const at = join(dir, 'node_modules', name); try { lstatSync(at); return; } catch {} mkdirSync(dirname(at), { recursive: true }); symlinkSync(target, at, 'dir'); }
const only = a.slice(2);
for (const [name, app] of Object.entries(APPS)) {
  if (only.length && !only.includes(name)) continue;
  const root = join(REPO, app.root ?? `bench/astro/out/sinter-${name}-100`);
  if (app.bench && !existsSync(root)) (await import(join(REPO, 'bench/astro/sinter-app.mjs'))).writeSinterApp(root, app.bench);
  link(root, '@tiaforge-ui/sinter', REPO);
  if (app.markdown) { link(root, '@tiaforge-ui/sinter-markdown', join(REPO, 'packages/sinter-markdown')); link(join(REPO, 'packages/sinter-markdown'), '@tiaforge-ui/sinter', REPO); }
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [import.meta.filename, '--child', root, join(OUT, name)], { cwd: REPO, encoding: 'utf8', env: { ...process.env } });
  console.log(name, r.status, Date.now() - t0, 'ms', r.status ? r.stderr.slice(0, 2000) : '');
}
