// What a type-checked build costs (docs/proposals/redesign-notes/stage4-check-once.md): the wall and CPU time of a
// build (or of `sinter check`), each run in a fresh child process, CPU counted with the `tsc` children it waits for
// (Linux: /proc/self/stat), and with --prof the inclusive CPU of the check's parts from a V8 profile.
//
//   node bench/check-bench.mjs <case> [--runs N] [--prof] [--mail <sinter-mail checkout>] [--pages N]
//
// cases: blog-files (100 posts, a page file each), blog-static (one template), check-blog (`sinter check` on
// blog-files), mail-api / mail-components (sinter-mail's route (ii) and (iii), --pages copies (default 12), with
// TypeScript resolvable from the app: linked from the checkout's node_modules). This repository must be built.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);

// ── Child: one build (or one `sinter check`), its times and its CPU with its children's ──────────────────────────
const cpu = () => {
  // utime, stime, cutime, cstime (fields 14 to 17) in clock ticks (100 a second on Linux)
  const f = readFileSync('/proc/self/stat', 'utf8').split(') ')[1].split(' ');
  return { self: (+f[11] + +f[12]) * 10, children: (+f[13] + +f[14]) * 10 };
};
if (argv[0] === '--child') {
  const [, kind, root] = argv;
  const t = performance.now();
  if (kind === 'check') {
    const r = spawnSync(process.execPath, [...(process.env.BENCH_PROF ? ['--cpu-prof', `--cpu-prof-dir=${process.env.BENCH_PROF}`] : []), join(REPO, 'dist/cli.js'), 'check', '--root', root], { encoding: 'utf8', maxBuffer: 1 << 28 });
    if (r.status !== 0 && r.status !== 1) { console.error(r.stderr); process.exit(2); }
  } else {
    const viteAt = existsSync(join(root, 'node_modules/vite')) ? join(root, 'node_modules/vite/dist/node/index.js') : 'vite';
    const { build } = await import(viteAt);
    const mail = kind === 'mail';
    try {
      if (mail) {
        const sinter = (await import(join(REPO, 'dist/vite.js'))).default;
        const input = Object.fromEntries(readdirSync(root).filter((f) => f.endsWith('.html')).map((f) => [f.slice(0, -5), join(root, f)]));
        await build({ root, configFile: false, logLevel: 'silent', plugins: [sinter({ libraries: ['@tiavision/sinter-mail'] })], build: { outDir: join(root, 'dist'), emptyOutDir: true, rollupOptions: { input } } });
      } else await build({ root, configFile: join(root, 'vite.config.js'), logLevel: 'silent' });
    } catch (e) { console.error(e?.stack ?? e); process.exit(2); }
  }
  const c = cpu();
  console.log(JSON.stringify({ ms: Math.round(performance.now() - t), cpu: c.self + c.children }));
  process.exit(0);
}

// ── Parent ────────────────────────────────────────────────────────────────────────────────────────────────────────
const flag = (f, d) => { const i = argv.indexOf(f); return i < 0 ? d : argv[i + 1]; };
const kase = argv[0];
const RUNS = +flag('--runs', 3), PAGES = +flag('--pages', 12), PROF = argv.includes('--prof');
const OUT = join(REPO, 'bench/astro/out');

function blog(files) {
  const root = join(OUT, files ? 'sinter-files-typecheck-100' : 'sinter-static-typecheck-100');
  if (!existsSync(join(root, 'vite.config.js'))) return import(join(REPO, 'bench/astro/sinter-app.mjs')).then((m) => { m.writeSinterApp(root, { n: 100, files, typecheck: true }); return root; });
  return Promise.resolve(root);
}

function mailApp(route) {
  const pkg = realpathSync(resolve(flag('--mail', join(REPO, '../tiavision/sinter-html'))));
  if (!existsSync(join(pkg, 'node_modules/typescript'))) throw new Error(`${pkg}: npm install there first`);
  const root = join(OUT, `mail-${route}-${PAGES}`);
  rmSync(root, { recursive: true, force: true });
  const RES = '<sn-resource name="message" src="/api/message" type="Body"></sn-resource>\n';
  const use = `body: n >= 0 ? message : null${route === 'components' ? ', templates: true' : ''}`;
  const body = `${RES}<main data-sn-state="{ n: 0 }"><mail-body id="message" data-sn-with="{ ${use} }"></mail-body><button id="again" data-sn-on-click="refresh(message)">again</button><button id="tick" data-sn-on-click="n++" data-sn-text="n"></button></main>`;
  const page = `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>t</title></head>\n<body>\n${body}\n</body>\n</html>\n`;
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/sinter.helpers.ts'), "export * as mail from '@tiavision/sinter-mail';\n");
  writeFileSync(join(root, 'src/sinter.types.ts'), "export type { Body, Element } from '@tiavision/sinter-mail';\n");
  writeFileSync(join(root, 'package.json'), '{ "name": "mail-bench", "private": true, "type": "module" }\n');
  for (let i = 0; i < PAGES; i++) writeFileSync(join(root, i ? `p${i}.html` : 'index.html'), page);
  mkdirSync(join(root, 'node_modules/@tiaforge-ui'), { recursive: true });
  mkdirSync(join(root, 'node_modules/@tiavision'), { recursive: true });
  symlinkSync(pkg, join(root, 'node_modules/@tiavision/sinter-mail'), 'dir');
  symlinkSync(realpathSync(REPO), join(root, 'node_modules/@tiaforge-ui/sinter'), 'dir');
  symlinkSync(join(pkg, 'node_modules/typescript'), join(root, 'node_modules/typescript'), 'dir');
  symlinkSync(join(pkg, 'node_modules/vite'), join(root, 'node_modules/vite'), 'dir');
  return root;
}

const cases = {
  'blog-files': async () => ['build', await blog(true)],
  'blog-static': async () => ['build', await blog(false)],
  'check-blog': async () => ['check', await blog(true)],
  'mail-api': async () => ['mail', mailApp('api')],
  'mail-components': async () => ['mail', mailApp('components')],
};
if (!cases[kase]) { console.error(`usage: node bench/check-bench.mjs <${Object.keys(cases).join('|')}> [--runs N] [--prof]`); process.exit(2); }
const [kind, root] = await cases[kase]();
const med = (xs) => { const v = [...xs].sort((a, b) => a - b); return v[v.length >> 1]; };
const runs = [];
const profDir = join(REPO, 'bench/astro/out', `prof-${kase}`);
for (let r = 0; r < RUNS + 1; r++) {
  const prof = PROF && r === RUNS;
  if (prof) { rmSync(profDir, { recursive: true, force: true }); mkdirSync(profDir, { recursive: true }); }
  const args = [...(prof && kind !== 'check' ? ['--cpu-prof', `--cpu-prof-dir=${profDir}`] : []), import.meta.filename, '--child', kind, root];
  const res = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, ...(prof && kind === 'check' ? { BENCH_PROF: profDir } : {}) } });
  if (res.status !== 0) { console.error(res.stdout, res.stderr); process.exit(2); }
  const m = JSON.parse(res.stdout.trim().split('\n').at(-1));
  if (r > 0 && !prof) runs.push(m); // (the first run warms the disk and Vite's caches)
  if (prof) console.log(JSON.stringify(profile(profDir)));
}
if (runs.length) console.log(JSON.stringify({ case: kase, runs: runs.length, wall: med(runs.map((x) => x.ms)), cpu: med(runs.map((x) => x.cpu)), all: runs.map((x) => `${x.ms}/${x.cpu}`).join(' ') }));

/** inclusive CPU ms of the check's functions (a function counted once where it calls itself) */
function profile(dir) {
  const NAMES = ['check', 'checkShared', 'shadowOf', 'shadow', 'unitCheck', 'spawnSync', 'parseTsc', 'flatten', 'partShadow', 'unitParts', 'compile', 'compileTwice'];
  const out = {};
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.cpuprofile'))) {
    const p = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const byId = new Map(p.nodes.map((n) => [n.id, n]));
    const parent = new Map();
    for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    const self = new Map();
    const dt = p.timeDeltas;
    for (let i = 0; i < p.samples.length; i++) self.set(p.samples[i], (self.get(p.samples[i]) ?? 0) + (dt[i] ?? 0) / 1000);
    for (const [id, ms] of self) {
      const seen = new Set();
      for (let n = id; n !== undefined; n = parent.get(n)) {
        const fn = byId.get(n).callFrame.functionName;
        if (NAMES.includes(fn) && !seen.has(fn)) { seen.add(fn); out[fn] = (out[fn] ?? 0) + ms; }
      }
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Math.round(v)]));
}
