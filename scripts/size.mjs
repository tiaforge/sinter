// Size budgets, per page (decided for 0.2, raised to 15 KB and 20 KB on 2026-11-07, the article to 22 KB on 2026-11-09 for next-page data, to 24 KB the same day for its early chunk: the signed-out header rendered before the first paint, no layout shift, to 26 KB the same day for its early requests: the API on another origin, requested before the stylesheets, to 27 KB the same day for its comment form without `data-sn-catch`: the fields module, 1.2 KB, which shows the server's errors in the form's list): min+gzip
// of a minimal page (one resource, one text binding) and of what each RealWorld page loads, without the
// libraries the example itself depends on (marked, DOMPurify: reported apart, not budgeted, since
// sinter does not choose them); the core and each feature module are reported for reference.
// `--check` fails on an overrun (CI runs it).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build, minify } from 'vite';
import { compile } from '../dist/compiler/index.js';

const dist = resolve(import.meta.dirname, '../dist');
const realworld = resolve(import.meta.dirname, '../examples/realworld');
const dir = mkdtempSync(join(tmpdir(), 'sinter-size-'));

// the RealWorld build needs the example's own dependencies (its config imports sinter through
// `file:../..`, its helpers marked and dompurify): installed here when they are missing, as CI does
if (!existsSync(join(realworld, 'node_modules/@tiaforge-ui/sinter/package.json'))) {
  console.log('size: installing the RealWorld example\'s dependencies (npm ci --prefix examples/realworld)');
  execFileSync('npm', ['ci', '--prefix', realworld, '--no-audit', '--no-fund'], { stdio: ['ignore', 'ignore', 'inherit'] });
}

/** The page module the compiler emits for a minimal page, its imports pointed at dist/. */
const minimal = compile('<html><body><sn-resource name="user" src="/api/user"></sn-resource><p data-sn-text="user.name"></p></body></html>', {
  file: '/min/index.html', root: '/min', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: () => '', moduleSrc: '/m.js',
}).module.replace(/'@tiaforge-ui\/sinter(\/[a-z]+)?'/g, (_, sub) => `'${dist}${sub ?? '/index'}.js'`);

const entries = {
  minimal,
  core: `export { mount, $k } from '${dist}/index.js';`,
  sse: `export { default } from '${dist}/sse.js';`,
  ws: `export { webSocketTransport } from '${dist}/ws.js';`,
  optimistic: `export { default } from '${dist}/optimistic.js';`,
  paginate: `export { default } from '${dist}/paginate.js';`,
  each: `export { default } from '${dist}/each.js';`,
  persist: `export { default } from '${dist}/persist.js';`,
  cache: `export { default } from '${dist}/cache.js';`,
  refresh: `export { default } from '${dist}/refresh.js';`,
  retry: `export { retry } from '${dist}/retry.js';`,
  versions: `export { default } from '${dist}/versions.js';`,
  keys: `export { default } from '${dist}/keys.js';`,
  apply: `export { default } from '${dist}/apply.js';`,
  prefetch: `export { prefetch } from '${dist}/prefetch.js';`,
  fields: `export { default } from '${dist}/fields.js';`,
  form: `export { default } from '${dist}/form.js';`,
  select: `export { default } from '${dist}/select.js';`,
  location: `export { default } from '${dist}/location.js';`,
  call: `export { default } from '${dist}/call.js';`,
  debounce: `export { default } from '${dist}/debounce.js';`,
  confirm: `export { default } from '${dist}/confirm.js';`,
  models: `export { default } from '${dist}/models.js';`,
  transition: `export { default } from '${dist}/transition.js';`,
  remote: `export { remote } from '${dist}/remote.js';`,
  dev: `export { default } from '${dist}/dev.js';`,
  // what the contacts example loads: core + sse + optimistic + persist
  page: `export { mount, $k } from '${dist}/index.js'; export { default as a } from '${dist}/sse.js'; export { default as b } from '${dist}/optimistic.js'; export { default as c } from '${dist}/persist.js';`,
};
// bytes, gzip -9; article: what the page loads, its page module and the app's own code included
const BUDGET = { minimal: 15 * 1024, 'realworld article': 27 * 1024 };
let failed = false;
const gz = (b) => gzipSync(b, { level: 9 }).length;
function report(name, min, size) {
  const budget = BUDGET[name];
  const over = budget && size > budget;
  if (over) failed = true;
  console.log(`${name.padEnd(19)} ${String(min).padStart(6)} B min  ${String(size).padStart(6)} B gzip${budget ? `  (budget ${budget})${over ? '  OVER' : ''}` : ''}`);
}
try {
  for (const [name, code] of Object.entries(entries)) {
    const entry = join(dir, `${name}.js`);
    writeFileSync(entry, code);
    const external = name === 'core' || name === 'page' || name === 'minimal' ? [] : [/\/runtime\//];
    await build({
      logLevel: 'silent', configFile: false,
      build: { outDir: join(dir, 'out', name), lib: { entry, formats: ['es'], fileName: name }, minify: false, rollupOptions: { external } },
    });
    // lib mode keeps whitespace in ES output; minify fully, as an app build would
    const out = await minify(`${name}.js`, readFileSync(join(dir, 'out', name, `${name}.js`), 'utf8'), { compress: true, mangle: true });
    const js = Buffer.from(out.code);
    report(name, js.length, gz(js));
  }

  // RealWorld: a production build; per page, the gzip of every script it loads (entry + modulepreload),
  // the example's own dependencies left out (external) and reported on their own
  const libs = Object.keys(JSON.parse(readFileSync(join(realworld, 'package.json'), 'utf8')).dependencies ?? {}).filter((d) => d !== '@tiaforge-ui/sinter');
  const out = join(dir, 'realworld');
  await build({ root: realworld, configFile: join(realworld, 'vite.config.js'), logLevel: 'silent', build: { outDir: out, emptyOutDir: true, rollupOptions: { external: libs } } });
  for (const f of readdirSync(out).filter((f) => f.endsWith('.html')).sort()) {
    const html = readFileSync(join(out, f), 'utf8');
    // each file once: the early file's shared chunk is preloaded with it and for the page bundle
    const srcs = [...new Set([...html.matchAll(/<script type="module"[^>]* src="([^"]+)"|<link rel="modulepreload"[^>]* href="([^"]+)"/g)].map((m) => m[1] ?? m[2]))];
    let raw = 0, size = 0;
    for (const s of srcs) {
      const code = readFileSync(join(out, s));
      raw += code.length;
      size += gz(code);
    }
    report(`realworld ${f.replace('.html', '')}`, raw, size);
  }
  // the example's libraries, each as the article page loads it (an entry inside the example, so it resolves there)
  const libDir = join(realworld, 'node_modules/.sinter-size');
  mkdirSync(libDir, { recursive: true });
  try {
    for (const lib of libs) {
      const entry = join(libDir, `${lib.replace(/\W/g, '_')}.js`);
      writeFileSync(entry, `import * as m from '${lib}';\nexport default m;\n`, { flag: 'w' });
      const o = join(dir, 'lib', lib);
      await build({ root: realworld, configFile: false, logLevel: 'silent', build: { outDir: o, minify: true, lib: { entry, formats: ['es'], fileName: 'lib' } } });
      const js = readFileSync(join(o, readdirSync(o).find((x) => x.endsWith('.js'))));
      console.log(`${`app library ${lib}`.padEnd(19)} ${String(js.length).padStart(6)} B min  ${String(gz(js)).padStart(6)} B gzip  (the example's own, not budgeted)`);
    }
  } finally {
    rmSync(libDir, { recursive: true, force: true });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (failed && process.argv.includes('--check')) process.exit(1);
