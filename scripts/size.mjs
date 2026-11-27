// Size budgets, per page (decided for 0.2, raised to 15 KB and 20 KB on 2026-11-07, the article to 22 KB on 2026-11-09 for next-page data, to 24 KB the same day for its early chunk: the signed-out header rendered before the first paint, no layout shift, to 26 KB the same day for its early requests: the API on another origin, requested before the stylesheets, to 27 KB the same day for its comment form without `data-sn-catch`: the fields module, 1.2 KB, which shows the server's errors in the form's list): min+gzip
// of a minimal page (one resource, one text binding) and of what each RealWorld page loads, without the
// libraries the example itself depends on (reported apart, not budgeted, since sinter does not choose them;
// sinter's own packages, such as @tiaforge-ui/sinter-markdown, are counted); the core and each feature
// module are reported for reference.
// `--check` fails on an overrun (CI runs it).
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build, minify } from 'vite';
import { compile } from '../dist/compiler/index.js';
import { resolveApis } from '../dist/compiler/apis.js';
import { flagsModule } from '../dist/core-parts.js';

const dist = resolve(import.meta.dirname, '../dist');
const realworld = resolve(import.meta.dirname, '../examples/realworld');
const multilingual = resolve(import.meta.dirname, '../examples/multilingual-site');
const dir = mkdtempSync(join(tmpdir(), 'sinter-size-'));

// the RealWorld build needs the example's own dependencies (its config imports sinter through
// `file:../..`, its helpers marked and dompurify): installed here when they are missing, as CI does
if (!existsSync(join(realworld, 'node_modules/@tiaforge-ui/sinter/package.json'))) {
  console.log('size: installing the RealWorld example\'s dependencies (npm ci --prefix examples/realworld)');
  execFileSync('npm', ['ci', '--prefix', realworld, '--no-audit', '--no-fund'], { stdio: ['ignore', 'ignore', 'inherit'] });
}

/** The page module the compiler emits for a minimal page, its imports pointed at dist/. */
const minimalOut = compile('<html><body><sn-resource name="user" src="/api/user"></sn-resource><p data-sn-text="user.name"></p></body></html>', {
  file: '/min/index.html', root: '/min', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: () => '', moduleSrc: '/m.js',
});
const minimal = minimalOut.module.replace(/'@tiaforge-ui\/sinter(\/runtime)?(\/[a-z-]+)?'/g, (_, rt, sub) => `'${dist}${sub ?? (rt ? '/runtime-entry' : '/index')}.js'`);

/** The same page in an app with swaps on: the stub and the build's list (`sinter({ swap: true })`) */
const swapList = join(dir, 'swap-list.js');
writeFileSync(swapList, `import { swap } from '${dist}/swap.js';\nexport default swap([{ m: ['/'] }, { m: ['/about'] }]);\n`);
const minimalSwapOut = compile('<html><body><sn-resource name="user" src="/api/user"></sn-resource><p data-sn-text="user.name"></p></body></html>', {
  file: '/min/index.html', root: '/min', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: () => '', moduleSrc: '/m.js', swap: true, swapList,
});
const minimalSwap = minimalSwapOut.module.replace(/'@tiaforge-ui\/sinter(\/runtime)?(\/[a-z-]+)?'/g, (_, rt, sub) => `'${dist}${sub ?? (rt ? '/runtime-entry' : '/index')}.js'`);

const toDist = (code) => code.replace(/'@tiaforge-ui\/sinter(\/runtime)?(\/[a-z-]+)?'/g, (_, rt, sub) => `'${dist}${sub ?? (rt ? '/runtime-entry' : '/index')}.js'`);
const minOptions = { file: '/min/index.html', root: '/min', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: () => '', moduleSrc: '/m.js' };
/** The minimal page with a link template (`data-sn-href`, 2026-11-20): what the page module adds for it */
const minimalLinkOut = compile('<html><body><sn-resource name="user" src="/api/user"></sn-resource><p data-sn-text="user.name"></p><a data-sn-href="/u/{user.name}">me</a></body></html>', minOptions);
/**
 * The minimal page with its resource on an API with a token (2026-11-20): the page module (the token module, the core's
 * token calls) and its early file, the head script a one-page site loads (the early runtime with the early requests
 * and the token's read)
 */
const tokenSpec = {
  openapi: '3.1.0', info: { title: 'size', version: '1' }, servers: [{ url: '/api' }],
  paths: { '/user': { get: { security: [{ Token: [] }], responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { user: { type: 'object', properties: { name: { type: 'string' } } } } } } } } } } } },
  components: { securitySchemes: { Token: { type: 'apiKey', in: 'header', name: 'Authorization' } } },
};
const tokenSpecs = [];
const tokenApis = resolveApis({ apis: { main: { openapi: tokenSpec, default: true, defaults: { 'GET /user': { select: 'user' } }, token: { storage: 'local:jwt', scheme: 'Token', signIn: '/login' } } } },
  (doc) => tokenSpecs.push({ file: '/min/openapi.json', doc }) - 1, tokenSpecs, '/min/vite.config.js');
if (tokenApis.diagnostics.length) throw new Error(`size: the token page's API: ${tokenApis.diagnostics.map((d) => d.message).join('; ')}`);
const minimalTokenOut = compile('<html><body><sn-resource name="user" src="/user"></sn-resource><p data-sn-text="user.name"></p></body></html>', { ...minOptions, apis: tokenApis.apis, openapi: tokenSpecs, early: { module: null } });

/**
 * The core as a build keeps it (docs/proposals/site-core.md), by entry: the parts that stay on. A minimal page's are its
 * own, read from its IR, as in an app whose only page it is; `core, no parts` is the floor every page loads. `core`
 * is the core with every part on, for reference (what dev serves).
 */
const siteCore = { minimal: minimalOut.core, 'minimal, swaps': minimalSwapOut.core, 'minimal, link': minimalLinkOut.core, 'minimal, token': minimalTokenOut.core, 'core, no parts': [] };
/** a build with an API's token sets the core's TOKEN flag */
const tokenCore = new Set(['minimal, token']);
const flagsFile = resolve(dist, 'runtime/flags.js');
const entries = {
  minimal,
  'minimal, swaps': minimalSwap,
  'minimal, link': toDist(minimalLinkOut.module),
  'minimal, token': toDist(minimalTokenOut.module),
  // its early file, the early runtime bundled in (a site's shared head script and the page's own, in one)
  'minimal, token, early': toDist(minimalTokenOut.early),
  core: `export { mount, $k } from '${dist}/runtime-entry.js';`,
  'core, no parts': `export { mount, $k } from '${dist}/runtime-entry.js';`,
  sse: `export { default } from '${dist}/sse.js';`,
  ws: `export { webSocketTransport } from '${dist}/ws.js';`,
  optimistic: `export { default } from '${dist}/optimistic.js';`,
  paginate: `export { default } from '${dist}/paginate.js';`,
  for: `export { default } from '${dist}/for.js';`,
  persist: `export { default } from '${dist}/persist.js';`,
  cache: `export { default } from '${dist}/cache.js';`,
  back: `export { default } from '${dist}/back.js';`,
  refresh: `export { default } from '${dist}/refresh.js';`,
  retry: `export { retry } from '${dist}/retry.js';`,
  versions: `export { default } from '${dist}/versions.js';`,
  keys: `export { default } from '${dist}/keys.js';`,
  'write-through': `export { default } from '${dist}/write-through.js';`,
  prefetch: `export { prefetch } from '${dist}/prefetch.js';`,
  fields: `export { default } from '${dist}/fields.js';`,
  form: `export { default } from '${dist}/form.js';`,
  select: `export { default } from '${dist}/select.js';`,
  location: `export { default } from '${dist}/location.js';`,
  typing: `export { default } from '${dist}/typing.js';`,
  'query-links': `export { default } from '${dist}/query-links.js';`,
  navigate: `export { default } from '${dist}/navigate.js';`,
  // the stub every page that swaps carries; the rest, loaded when a navigation needs it
  swap: `export { swap } from '${dist}/swap.js';`,
  'swap, the rest': `export { prepare } from '${dist}/swap-run.js';`,
  call: `export { default } from '${dist}/call.js';`,
  debounce: `export { default } from '${dist}/debounce.js';`,
  confirm: `export { default } from '${dist}/confirm.js';`,
  models: `export { default } from '${dist}/models.js';`,
  transition: `export { default } from '${dist}/transition.js';`,
  components: `export { default, Component } from '${dist}/components.js';`,
  nested: `export { default } from '${dist}/nested.js';`,
  lets: `export { default } from '${dist}/lets.js';`,
  memo: `export { memo } from '${dist}/memo.js';`,
  remote: `export { remote } from '${dist}/remote.js';`,
  dev: `export { default } from '${dist}/dev.js';`,
  // what the contacts example loads: core + sse + optimistic + persist
  page: `export { mount, $k } from '${dist}/runtime-entry.js'; export { default as a } from '${dist}/sse.js'; export { default as b } from '${dist}/optimistic.js'; export { default as c } from '${dist}/persist.js';`,
};
// bytes, gzip -9; article: what the page loads, its page module and the app's own code included
// the minimal page in an app with swaps on (2026-11-16): the stub every page that swaps carries (1.7 KB, the
// navigation chain 0.9 KB of it) does not fit 15 KB after trimming, so these pages have a budget of their own.
// Raised on 2026-11-17, after trimming the core: the minimal page to 16 KB (main was at 15,492 B on its own,
// swap navigation adds 74 B to the core: the chain's hooks in navigate() and popstate, the flush guard, the
// attribute writer leaving unchanged values); the article to 28.5 KB (RealWorld runs with swaps on: the stub,
// the chain shared by same-page links, morphs and the swap). The article to 35 KB the same day, when the
// count took in the classic head scripts it had left out (sinter's early script and the page's early chunk,
// about 3 KB per page), with room for the next features. The article to 62 KB on 2026-11-17, when its body
// moved from marked and DOMPurify (the example's own libraries, 22.4 KB, never counted here) to
// @tiaforge-ui/sinter-markdown, which is counted: 31.1 → 59.8 KB, the parser 21.8 KB of it
// Lowered on 2026-11-17 with the site's core (docs/proposals/site-core.md): a build keeps only the parts of the core its
// pages use. The minimal page to 12 KB (11,046 B: the resource part alone over the 7.4 KB floor), with swaps to 13.5 KB
// (12,860 B); the article stays at 62 KB (59,231 B: RealWorld keeps 6 of the 9 parts)
// Added on 2026-11-20, after the size pass over the features merged since 0.20 (each a little above where it was then):
// a link template (11,522 B), a token API (the page module 12,548 B, its early file 2,326 B: the early requests and the
// token's read) and RealWorld's shared head script on its own (3,706 B), the early runtime every page loads
// Lowered on 2026-11-20, when the URL templates and the early requests moved to the compiler (`expand()` left the core,
// the early runtime interprets no request): the minimal page to 11 KB (11,192 B), with swaps to 12.875 KB (13,065 B), with
// a link to 11.125 KB (11,320 B), with a token to 12.125 KB (12,256 B) and its early file to 1.875 KB (1,770 B), RealWorld's
// shared head script to 3.375 KB (3,283 B) and the article to 60 KB (61,290 B)
// Lowered on 2026-11-21: the article to 58.375 KB (59,597 B), when sinter-markdown's parser drove markdown-it's parsers
// without its class (1,443 B: the presets, the renderer, the plugin API) and a map's `<sn-component use>` became one
// table keyed by the map's keys (250 B: md-doc's dispatch, in each of its 25 places); to 58.125 KB (59,419 B) the same
// day, when the parser's entity table grouped the names that share a value (178 B); to 57.125 KB (58,374 B) the same day,
// when templates several shared definitions write alike were kept once (1,039 B: md-doc's loop over a node's children,
// written in 20 of its components); to 56.5 KB (57,767 B) on 2026-11-21, when a build's last pass over the page's
// tables took out the templates nothing renders, each template's id and the functions nothing calls (466 B); to
// 56.625 KB (57,887 B) the same day, with #92's fixes (alias writes, swaps, the first paint: 97 B); to 56.5 KB (57,784 B) the
// same day, when the runtime's duplicated helpers were kept once (80 B: the dotted-path read, a page-load entry's write, `env.replace`)
// Added on 2026-11-21 (docs/proposals/axes.md, step 0): a page in two languages, the multilingual example's German status
// page: the scripts it loads (12,740 B: its page module and the runtime) and its HTML (813 B), so the axes work shows
// what it changes for a language's page
// Raised on 2026-11-21 to 12.625 KB (12,873 B): the example moved to `inlang()` (docs/proposals/messages.md, step 4), and
// the messages module carries both ways until `sinter({ messages })` is removed: `install()`, nested ids and an
// entry's pattern beside `fixed()` (146 B); the page's own message is inlined (`inline()`), with no formatter
// Lowered on 2026-11-21, when the core gave back what #94's event caches cost and more (59 B): the minimal page with a
// token to 12 KB (12,263 B), the article to 56.375 KB (57,711 B)
// Raised on 2026-11-22 to 56.625 KB (57,853 B): <md-doc> renders the article's body with a script (<md-view>, sinter-markdown's
// build.ts) instead of the components: 4.5 kB smaller minified, 142 B larger gzip (code compresses less than template markup)
// Raised on 2026-11-22 to 56.875 KB (58,191 B): text web fonts load after the page (`fonts()` in early.ts, its <noscript>, the
// returning-reader note and the 2 s cap: about 230 B gzip), which takes the profile page's Lighthouse score from 99 to 100
// Raised on 2026-11-22 to 57.125 KB (58,467 B): a list whose focused row goes moves the focus to the row now in its place
// instead of leaving it on <body> (accessibility; 229 B gzip in the page runtime)
// Raised on 2026-11-26 to 57.25 KB (58,624 B): the app's config module resends a GET that the API answered 401 without its token
// (`publicReads`, examples/realworld/src/sinter.config.js: the official Nitro backend refuses a bad token on public reads, and
// sinter signs the reader out on any 401): 91 B gzip in every page
// Raised on 2026-11-26 to 57.375 KB (58,752 B): RealWorld's layout has `<html lang="en">` and its config sets no locale,
// so its pages that format dates now set that locale (`$lang("en")` in the page module and the early file): 31 B gzip
// on the article (index and profile +32 B). The minimal pages' raises of the same day (for the resource handle's `src`
// and `order` and a registry of runtime copies) were taken back on 2026-11-27 with those two: the minimal pages are
// as on 2026-11-25
// Lowered on 2026-11-27, when a core without lists and branches stopped carrying their code (`walk()` in src/runtime/app.ts
// asks the LIST and BRANCH flags in a statement of their own: after `if (… || true) continue;` the minifier kept the rest of
// the loop, 2.4 kB minified; `core, no parts` 7,207 B to 6,229 B): the minimal page to 10.125 KB (10,246 B), with swaps to
// 12 KB (12,208 B), with a link to 10.25 KB (10,375 B), with a token to 11.125 KB (11,322 B), the multilingual status page
// to 11.375 KB (11,555 B). RealWorld has lists and branches: unchanged
// Lowered on 2026-11-27, when the store functions (`openDialog()`, `merge()`, `refresh()`, `emit()`, `run()`, …) became
// parts of the site's core: a group stays only when a page's handlers name one of them (`FN_*`, src/core-parts.ts; 733 B
// minified where none is called): the minimal page to 9.75 KB (9,955 B), with swaps to 11.75 KB (11,934 B), with a link
// to 9.875 KB (10,088 B), with a token to 10.875 KB (11,028 B), the multilingual status page to 11.125 KB (11,270 B), the
// article to 57.125 KB (58,446 B: RealWorld's handlers call `merge()` and `refresh()`, the dialog, page, emit and run
// groups go)
const BUDGET = {
  'multilingual de/status': 11.125 * 1024, 'multilingual de/status, html': 0.875 * 1024,
  minimal: 9.75 * 1024, 'minimal, swaps': 11.75 * 1024, 'realworld article': 57.125 * 1024,
  'minimal, link': 9.875 * 1024, 'minimal, token': 10.875 * 1024, 'minimal, token, early': 1.875 * 1024, 'realworld early, shared': 3.375 * 1024,
};
let failed = false;
const gz = (b) => gzipSync(b, { level: 9 }).length;
function report(name, min, size) {
  const budget = BUDGET[name];
  const over = budget && size > budget;
  if (over) failed = true;
  console.log(`${name.padEnd(23)} ${String(min).padStart(6)} B min  ${String(size).padStart(6)} B gzip${budget ? `  (budget ${budget})${over ? '  OVER' : ''}` : ''}`);
}
try {
  for (const [name, code] of Object.entries(entries)) {
    const entry = join(dir, `${name}.js`);
    writeFileSync(entry, code);
    const external = name === 'core' || name === 'page' || name.startsWith('minimal') || siteCore[name] ? [] : [/\/runtime\//];
    await build({
      logLevel: 'silent', configFile: false,
      build: { outDir: join(dir, 'out', name), lib: { entry, formats: ['es'], fileName: name }, minify: false, rollupOptions: { external } },
      plugins: siteCore[name] ? [{ name: 'site-core', load: (id) => (id === flagsFile ? flagsModule(siteCore[name], false, false, tokenCore.has(name)) : null) }] : [],
    });
    // lib mode keeps whitespace in ES output; minify fully, as an app build would. A module with an
    // `import()` (the swap's rest) is split: what the entry imports statically is counted, the rest is not
    const files = [], seen = new Set();
    const walk = (f) => {
      if (seen.has(f)) return;
      seen.add(f);
      const text = readFileSync(join(dir, 'out', name, f), 'utf8');
      files.push([f, text]);
      for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*)["']\.\/([^"']+\.js)["']/g)) if (existsSync(join(dir, 'out', name, m[1]))) walk(m[1]);
    };
    walk(`${name}.js`);
    const parts = [];
    for (const [f, text] of files) parts.push((await minify(f, text, { compress: true, mangle: true })).code);
    const js = Buffer.from(parts.join('\n'));
    report(name, js.length, gz(js));
  }

  // RealWorld: a production build; per page, the gzip of every script it loads (entry + modulepreload),
  // the example's own dependencies left out (external) and reported on their own; sinter's own packages
  // (@tiaforge-ui/sinter-markdown, the article's body) are counted with the page
  const libs = Object.keys(JSON.parse(readFileSync(join(realworld, 'package.json'), 'utf8')).dependencies ?? {}).filter((d) => !d.startsWith('@tiaforge-ui/'));
  const out = join(dir, 'realworld');
  await build({ root: realworld, configFile: join(realworld, 'vite.config.js'), logLevel: 'silent', build: { outDir: out, emptyOutDir: true, rollupOptions: { external: libs } } });
  // the shared head script on its own (2026-11-20): the early runtime every page loads (its early requests, the token's read)
  const head = readdirSync(join(out, 'assets')).find((f) => /^sinter-head-.*\.js$/.test(f));
  if (head) { const code = readFileSync(join(out, 'assets', head)); report('realworld early, shared', code.length, gz(code)); }
  for (const f of readdirSync(out).filter((f) => f.endsWith('.html')).sort()) {
    const html = readFileSync(join(out, f), 'utf8');
    // each file once: the early file's shared chunk is preloaded with it and for the page bundle; the
    // classic head scripts (sinter's early script, the page's early chunk) count too
    const srcs = [...new Set([...html.matchAll(/<script\b[^>]* src="([^"]+)"|<link rel="modulepreload"[^>]* href="([^"]+)"/g)].map((m) => m[1] ?? m[2]))];
    let raw = 0, size = 0;
    for (const s of srcs) {
      const code = readFileSync(join(out, s));
      raw += code.length;
      size += gz(code);
    }
    report(`realworld ${f.replace('.html', '')}`, raw, size);
  }
  // a page in two languages (localePrefix): the multilingual example's German status page, its scripts and its HTML.
  // The example needs nothing but sinter, linked to this checkout as `file:../..` would
  const mlLink = join(multilingual, 'node_modules/@tiaforge-ui/sinter');
  try { lstatSync(mlLink); } catch { mkdirSync(join(multilingual, 'node_modules/@tiaforge-ui'), { recursive: true }); symlinkSync(resolve(import.meta.dirname, '..'), mlLink, 'dir'); }
  const mlOut = join(dir, 'multilingual');
  await build({ root: multilingual, configFile: join(multilingual, 'vite.config.js'), logLevel: 'silent', build: { outDir: mlOut, emptyOutDir: true } });
  {
    const html = readFileSync(join(mlOut, 'de/status/index.html'));
    const srcs = [...new Set([...html.toString().matchAll(/<script\b[^>]* src="([^"]+)"|<link rel="modulepreload"[^>]* href="([^"]+)"/g)].map((m) => m[1] ?? m[2]))];
    let raw = 0, size = 0;
    for (const s of srcs) { const code = readFileSync(join(mlOut, s)); raw += code.length; size += gz(code); }
    report('multilingual de/status', raw, size);
    report('multilingual de/status, html', html.length, gz(html));
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
