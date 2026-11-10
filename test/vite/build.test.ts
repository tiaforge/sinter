// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, createLogger, createServer, preview } from 'vite';
import { afterAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';

const root = resolve(__dirname, '../fixtures/vite-app');
const src = resolve(__dirname, '../../src');
const out = mkdtempSync(join(tmpdir(), 'sinter-vite-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

const alias = ['sse', 'optimistic', 'paginate', 'persist', 'early', 'prefetch', 'transition', 'form', 'select', 'location', 'call', 'debounce', 'confirm', 'models']
  .map((f) => ({ find: `@tiaforge-ui/sinter/${f}`, replacement: `${src}/${f}.ts` }))
  .concat([{ find: '@tiaforge-ui/sinter', replacement: `${src}/index.ts` }]);

/** the page's head scripts, first in the head: the shared one (`sinter-head-…`) and the page's own (`<page>-head-…`) */
function heads(html: string, dir: string, page = 'index') {
  const shared = new RegExp(`<script src="/assets/(sinter-head-[\\w-]+\\.js)"( data-sn-i18n="([^"]+)")?></script>`).exec(html);
  const own = new RegExp(`<script src="/assets/(${page}-head-[\\w-]+\\.js)"></script>`).exec(html);
  const read = (m: RegExpExecArray | null) => (m ? readFileSync(join(dir, 'assets', m[1]!), 'utf8') : '');
  return { shared, own, sharedCode: read(shared), ownCode: read(own), i18n: shared?.[3] ? JSON.parse(shared[3].replace(/&#34;/g, '"')) : null };
}

async function run(outDir: string) {
  return build({ root, logLevel: 'silent', plugins: [sinter()], resolve: { alias }, build: { outDir, emptyOutDir: true, minify: false } });
}

test('builds a page: rewritten HTML, page module, helpers, namespace members and called actions', async () => {
  await run(out);
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  // no directive is left; the head scripts, the shared one then the page's, come before the page bundle and its preloads
  const tags = /<script src="\/assets\/sinter-head-[\w-]+\.js"><\/script>\s*<script src="\/assets\/index-head-[\w-]+\.js"><\/script>/.exec(html);
  expect(tags).not.toBeNull();
  expect(tags!.index).toBeLessThan(html.search(/<script type="module"|<link rel="modulepreload"/));
  expect(html).not.toContain('data-sn-');
  expect(html).not.toContain('blocking=');
  expect(html).not.toContain('sn-resource');
  // the page bundle is async: it does not wait for the stylesheets
  expect(html).toMatch(/<script type="module" crossorigin src="\/assets\/[^"]+\.js" async><\/script>/);
  const js = readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(out, 'assets', f), 'utf8')).join('\n');
  expect(js).toContain('People');
  expect(js).toContain('toUpperCase');
  expect(js).toContain('X-Sinter');
  expect(js).toContain('hello from the actions module');
  expect(js).not.toContain('never called');
  expect(js).not.toContain('tree-shaken');
  expect(js).not.toMatch(/(^|[^.\w$])eval\(|new Function\(/);
});

test('next-page data: every page shares one module describing the pages; `prefetch: false` leaves it out', async () => {
  const js = (dir: string) => readdirSync(join(dir, 'assets')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(dir, 'assets', f), 'utf8')).join('\n');
  await run(out);
  // the fixture's index page: its people request needs nothing but the URL
  expect(js(out).replace(/\s+/g, '')).toContain(`prefetch([{m:["/","/index.html"],r:[{"s":["/api/people"],"i":null,"t":null,"k":1}]`);
  const dir = join(out, 'no-prefetch');
  await build({ root, logLevel: 'silent', resolve: { alias }, build: { outDir: dir, emptyOutDir: true, minify: false }, plugins: [sinter({ prefetch: false })] });
  expect(js(dir)).not.toContain('"/index.html"');
  expect(js(dir)).not.toContain('pointerover');
});

test('`<html data-sn-prefetch="off">`: the page is in neither the next-page module nor the rules', async () => {
  const page = join(root, 'index.html');
  const original = readFileSync(page, 'utf8');
  writeFileSync(page, original.replace(/<html([^>]*)>/, '<html$1 data-sn-prefetch="off">'));
  try {
    const dir = join(out, 'off');
    await build({ root, logLevel: 'silent', resolve: { alias }, build: { outDir: dir, emptyOutDir: true, minify: false }, plugins: [sinter()] });
    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    expect(html).not.toContain('speculationrules');
    // the app's only page is left out: no page to describe, no next-page module
    expect(readdirSync(join(dir, 'assets')).map((f) => readFileSync(join(dir, 'assets', f), 'utf8')).join('\n')).not.toContain('"/index.html"');
    expect(html).not.toContain('data-sn-prefetch');
  } finally {
    writeFileSync(page, original);
  }
});

test('embedded data: `sinter-embed.json` lists each placeholder with its `data-sn` id and the request a server makes for it', async () => {
  const page = join(root, 'index.html');
  const original = readFileSync(page, 'utf8');
  writeFileSync(page, original
    .replace('<head><title>app</title></head>', '<head><title>app</title><script type="application/json" data-sn-data="people"></script><script type="application/json" data-sn-data="person"></script></head>')
    .replace('<sn-resource name="people"', '<sn-resource name="person" src="/api/people/{$url.id}?full=1" when="$url.id"></sn-resource><p data-sn-text="person.name"></p>\n  <sn-resource name="people"'));
  try {
    const dir = join(out, 'embed');
    await build({ root, logLevel: 'silent', resolve: { alias }, build: { outDir: dir, emptyOutDir: true, minify: false }, plugins: [sinter()] });
    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    const manifest = JSON.parse(readFileSync(join(dir, 'sinter-embed.json'), 'utf8'));
    expect(manifest.version).toBe(1);
    expect(manifest.pages).toHaveLength(1);
    const p = manifest.pages[0];
    expect(p.file).toBe('index.html');
    expect(p.paths).toEqual(['/', '/index.html']);
    const people = p.data.find((d: { resource: string }) => d.resource === 'people');
    const person = p.data.find((d: { resource: string }) => d.resource === 'person');
    expect(people.src).toEqual(['/api/people']);
    expect(person).toMatchObject({ src: ['/api/people/', { url: 'id' }, '?full=1'], when: true });
    // the ids are the ones in the built HTML
    for (const d of p.data) expect(html).toContain(`<script type="application/json" data-sn="${d.id}"></script>`);
  } finally {
    writeFileSync(page, original);
  }
  // without placeholders, no file
  await run(join(out, 'no-embed'));
  expect(readdirSync(join(out, 'no-embed'))).not.toContain('sinter-embed.json');
});

test('`delivery: \'header\'`: a rules file at the site root, no inline script; `vite preview` sends the header and its type', async () => {
  const dir = join(out, 'header');
  const config = { root, logLevel: 'silent' as const, resolve: { alias }, build: { outDir: dir, emptyOutDir: true, minify: false }, plugins: [sinter({ speculation: { mode: 'prerender', delivery: 'header' } })] };
  await build(config);
  expect(readFileSync(join(dir, 'index.html'), 'utf8')).not.toContain('speculationrules');
  expect(JSON.parse(readFileSync(join(dir, 'speculation-rules.json'), 'utf8')).prerender[0].where.and[0].href_matches).toEqual(['/\\?*#*', '/index.html\\?*#*']);
  const server = await preview({ ...config, preview: { port: 0, host: '127.0.0.1' } });
  try {
    const url = server.resolvedUrls!.local[0]!;
    const page = await fetch(url, { headers: { Accept: 'text/html' } });
    expect(page.headers.get('speculation-rules')).toBe('"/speculation-rules.json"');
    const rules = await fetch(new URL('speculation-rules.json', url));
    expect(rules.headers.get('content-type')).toBe('application/speculationrules+json');
  } finally {
    await server.close();
  }
});

test('a page that uses data-sn-transition gets the hold script in its own head script, before its page module; others do not', async () => {
  const page = join(root, 'index.html');
  const original = readFileSync(page, 'utf8');
  const plain = readFileSync(join(out, 'index.html'), 'utf8');
  expect(heads(plain, out).ownCode).not.toContain('sn:vt');
  writeFileSync(page, original.replace('<input data-sn-model="q">', '<input data-sn-model="q"><h2 data-sn-transition="\'people\'">People</h2>'));
  try {
    const dir = join(out, 'hold');
    await build({ root, logLevel: 'silent', resolve: { alias }, build: { outDir: dir, emptyOutDir: true, minify: false }, plugins: [sinter()] });
    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    // the hold script is in the page's own head script (with its early bindings): one tag, before the page module
    const h = heads(html, dir), module = html.search(/<script type="module" crossorigin src="\/assets\/index-[\w-]+\.js" async>/);
    expect(h.own).not.toBeNull();
    expect(html.indexOf(h.own![0])).toBeLessThan(module);
    expect(h.ownCode).toContain('sn:vt');
    expect(h.sharedCode).not.toContain('sn:vt');
    expect(readdirSync(join(dir, 'assets')).some((f) => /^sinter-(hold|paint)-/.test(f))).toBe(false);
  } finally {
    writeFileSync(page, original);
  }
});

test('by default every page carries inline rules for the app\'s paths; `speculation: false`: neither rules nor file', async () => {
  await run(out);
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  const rules = JSON.parse(/<script type="speculationrules">(.*?)<\/script>/.exec(html)![1]!);
  expect(rules.prefetch[0].where.and[0].href_matches).toEqual(['/\\?*#*', '/index.html\\?*#*']);
  expect(readdirSync(out)).not.toContain('speculation-rules.json');
  const dir = join(out, 'no-speculation');
  await build({ root, logLevel: 'silent', resolve: { alias }, build: { outDir: dir, emptyOutDir: true, minify: false }, plugins: [sinter({ speculation: false })] });
  expect(readFileSync(join(dir, 'index.html'), 'utf8')).not.toContain('speculationrules');
  expect(readdirSync(dir)).not.toContain('speculation-rules.json');
});

/** a logger that keeps the info lines, for the build's hints */
function infoLogger() {
  const lines: string[] = [], logger = createLogger('silent');
  logger.info = (m: string) => { lines.push(m); };
  return { lines, logger };
}

test('the build names the CSP keyword only for pages without a CSP <meta>', async () => {
  const { lines, logger } = infoLogger();
  await build({ root, customLogger: logger, resolve: { alias }, build: { outDir: join(out, 'hint'), emptyOutDir: true, minify: false }, plugins: [sinter()] });
  const hint = lines.find((l) => l.includes('Speculation Rules'));
  expect(hint).toMatch(/nothing to do without a CSP; a CSP sent as a response header must allow them: add 'inline-speculation-rules'/);
  expect(hint).not.toMatch(/by a response header, needs no CSP change/);
});

test('a CSP the page declares in a <meta> gets the inline rules\' hash', async () => {
  const page = join(root, 'index.html');
  const original = readFileSync(page, 'utf8');
  writeFileSync(page, original.replace(/<head>/, `<head>\n  <meta http-equiv="Content-Security-Policy" content="script-src 'self'">`));
  try {
    const dir = join(out, 'csp-meta');
    const { lines, logger } = infoLogger();
    await build({ root, customLogger: logger, resolve: { alias }, build: { outDir: dir, emptyOutDir: true, minify: false }, plugins: [sinter()] });
    // the hash is in the page: nothing for anyone to add
    expect(lines.some((l) => l.includes('Speculation Rules'))).toBe(false);
    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    const json = /<script type="speculationrules">(.*?)<\/script>/.exec(html)![1]!;
    const hash = `sha256-${createHash('sha256').update(json).digest('base64')}`;
    expect(/http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)![1]).toBe(`script-src 'self' '${hash}'`);
  } finally {
    writeFileSync(page, original);
  }
});

test('a CSP header with a nonce: Vite\'s html.cspNonce puts it on the inline rules, in build and dev', async () => {
  const dir = join(out, 'csp-nonce');
  await build({ root, logLevel: 'silent', resolve: { alias }, html: { cspNonce: 'NONCE' }, build: { outDir: dir, emptyOutDir: true, minify: false }, plugins: [sinter()] });
  expect(readFileSync(join(dir, 'index.html'), 'utf8')).toMatch(/<script type="speculationrules" nonce="NONCE">/);
  const server = await createServer({ root, logLevel: 'silent', resolve: { alias }, html: { cspNonce: 'NONCE' }, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', plugins: [sinter()] });
  try {
    const html = await server.transformIndexHtml('/index.html', readFileSync(join(root, 'index.html'), 'utf8'));
    expect(html).toMatch(/<script type="speculationrules" nonce="NONCE">/);
  } finally {
    await server.close();
  }
});

test('compile errors fail the build with the diagnostic', async () => {
  const page = join(root, 'index.html');
  const original = readFileSync(page, 'utf8');
  writeFileSync(page, original.replace('data-sn-model="q"', 'data-sn-modle="q"'));
  try {
    await expect(run(join(out, 'bad'))).rejects.toThrow(/SN101 unknown-attribute: `data-sn-modle` is not a sinter attribute. Did you mean `data-sn-model`\?/);
  } finally {
    writeFileSync(page, original);
  }
});

test('typecheck: type errors fail `vite build` with SN208', async () => {
  const page = join(root, 'index.html');
  const original = readFileSync(page, 'utf8');
  writeFileSync(page, original.replace('</body>', '<p data-sn-text="(1).nope"></p></body>'));
  try {
    await expect(build({
      root, logLevel: 'silent', plugins: [sinter({ typecheck: true })], resolve: { alias },
      build: { outDir: join(out, 'typecheck'), emptyOutDir: true, minify: false },
    })).rejects.toThrow(/SN208 type-error: Property 'nope' does not exist on type '1'/);
  } finally {
    writeFileSync(page, original);
    rmSync(join(root, '.sinter'), { recursive: true, force: true });
  }
});

test('first paint: a classic head script per page over one shared by every page, before the page module; nothing render-blocking', async () => {
  const dir = join(out, 'first-paint');
  const logs: string[] = [];
  await build({
    root, resolve: { alias }, build: { outDir: dir, emptyOutDir: true, minify: false },
    customLogger: { info: (m: string) => { logs.push(m); }, warn: (m: string) => { logs.push(m); }, warnOnce: () => {}, error: () => {}, clearScreen: () => {}, hasErrorLogged: () => false, hasWarned: false } as never,
    plugins: [sinter({ earlyBudget: 1 })],
  });
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  const h = heads(html, dir);
  expect(h.shared).not.toBeNull();
  expect(h.own).not.toBeNull();
  const page = /<script type="module" crossorigin src="\/assets\/(index-[\w-]+\.js)" async><\/script>/.exec(html);
  expect(page).not.toBeNull();
  expect(html.indexOf(h.shared![0])).toBeLessThan(html.indexOf(h.own![0]));
  expect(html.indexOf(h.own![0])).toBeLessThan(html.indexOf(page![0]));
  expect(html).not.toContain('blocking=');
  // classic scripts, nothing imported, nothing requested for them ahead of their tags
  for (const code of [h.sharedCode, h.ownCode]) {
    expect(code).not.toMatch(/^\s*(import|export)\s/m);
    expect(code).not.toMatch(/\bimport\(/);
  }
  expect(html.slice(0, html.indexOf(h.own![0]))).not.toContain('rel="modulepreload"');
  // the shared one: the app's early module and the runtime; the page's: its compiled bindings, over the runtime's global
  expect(h.sharedCode).toMatch(/dataset\.early = ["']yes["']/);
  expect(h.sharedCode).toContain('MutationObserver');
  expect(h.ownCode).not.toContain('MutationObserver');
  expect(h.ownCode).not.toMatch(/dataset\.early = /);
  expect(h.ownCode).toContain('People');
  const both = h.sharedCode + h.ownCode;
  expect(both).toContain('not available early');
  // not the page's other helpers, nor the page runtime
  expect(both).not.toContain('toUpperCase');
  expect(both).not.toContain('mount(');
  // the page module (async) mounts once the early script has rendered
  expect(readFileSync(join(dir, 'assets', page![1]!), 'utf8')).toMatch(/await rendered\(\);[\s\S]*mount\(document/);
  // the build reports the early scripts' size, and warns over the budget with the largest modules
  expect(logs.find((l) => l.includes('early script of index.html'))).toMatch(/early script of index\.html: assets\/index-head-[\w-]+\.js [\d.]+ kB gzip \+ assets\/sinter-head-[\w-]+\.js [\d.]+ kB gzip \(shared\), over the early budget of 0\.0 kB.*Largest \(before gzip\): /s);
  // `firstPaint: false`: everything waits for the page module
  await build({ root, logLevel: 'silent', resolve: { alias }, build: { outDir: join(dir, 'off'), emptyOutDir: true, minify: false }, plugins: [sinter({ firstPaint: false })] });
  const off = readFileSync(join(dir, 'off', 'index.html'), 'utf8');
  expect(off).not.toContain('-head-');
  expect(off).not.toContain('blocking');
});

test('first paint: an early binding that checks a URL: the check is in the shared head script once, not in the page\'s', async () => {
  const file = join(root, 'shared.html');
  writeFileSync(file, '<!doctype html><html><head><title>x</title></head><body data-sn-state="{ to: \'/a\' }" data-sn-persist="nav"><a data-sn-attr="{href: to}">a</a><sn-resource name="people" src="/api/people" key="id"></sn-resource><p data-sn-text="people.length"></p></body></html>');
  const dir = join(out, 'early-shared');
  try {
    await build({ root, logLevel: 'silent', resolve: { alias }, build: { outDir: dir, emptyOutDir: true, minify: false, rollupOptions: { input: file } }, plugins: [sinter()] });
  } finally { rmSync(file, { force: true }); }
  const h = heads(readFileSync(join(dir, 'shared.html'), 'utf8'), dir, 'shared');
  expect(h.sharedCode).toContain('function urlAllowed');
  expect(h.ownCode).not.toContain('function urlAllowed');
});

test('first paint: an early module\'s dynamic import is inlined, without a deprecated-option warning', async () => {
  const early = join(root, 'src', 'sinter.early.js'), lazy = join(root, 'src', 'early-lazy.js');
  const original = readFileSync(early, 'utf8');
  writeFileSync(lazy, "export const lazyMark = 'lazy-early-module';\n");
  writeFileSync(early, original + "import('./early-lazy.js').then((m) => { document.documentElement.dataset.lazy = m.lazyMark; });\n");
  const said: string[] = [];
  const keep = { warn: console.warn, log: console.log, err: process.stderr.write, out: process.stdout.write };
  console.warn = (...a: unknown[]) => { said.push(a.join(' ')); };
  console.log = (...a: unknown[]) => { said.push(a.join(' ')); };
  process.stderr.write = ((c: string | Uint8Array) => { said.push(String(c)); return true; }) as never;
  process.stdout.write = ((c: string | Uint8Array) => { said.push(String(c)); return true; }) as never;
  const dir = join(out, 'early-dynamic');
  try {
    await build({ root, logLevel: 'silent', resolve: { alias }, build: { outDir: dir, emptyOutDir: true, minify: false }, plugins: [sinter()] });
  } finally {
    Object.assign(console, { warn: keep.warn, log: keep.log });
    process.stderr.write = keep.err; process.stdout.write = keep.out;
    writeFileSync(early, original);
    rmSync(lazy, { force: true });
  }
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  // the app's early module is in the shared head script
  const code = heads(html, dir).sharedCode;
  expect(code).toContain('lazy-early-module');            // in the head script itself
  // which loads nothing (Vite's preload helper reads import.meta): no dynamic import, and here no static one either
  expect(code).not.toMatch(/\bimport\(/);
  expect(code).not.toMatch(/^\s*import\s/m);
  expect(said.join('\n')).not.toMatch(/inlineDynamicImports|codeSplitting/);
});

test('first paint in the dev server: the early script as in builds, one classic script first in the head, the runtime bundled in', async () => {
  const server = await createServer({ root, logLevel: 'silent', resolve: { alias }, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', plugins: [sinter()] });
  try {
    const html = await server.transformIndexHtml('/index.html', readFileSync(join(root, 'index.html'), 'utf8'));
    const tag = html.indexOf('<script src="/@sinter/early/index.html.js"></script>');
    expect(tag).toBeGreaterThan(0);
    expect(tag).toBeLessThan(html.indexOf('<script type="module" src="/@sinter/index.html.js"></script>'));
    expect(html).not.toContain('blocking=');
    const js = await server.transformRequest('/@sinter/early/index.html.js');
    expect(js?.code).toContain('MutationObserver');
    expect(js?.code).toMatch(/dataset\.early = ["']yes["']/);   // the app's early module
    expect(js?.code).not.toMatch(/^\s*(import|export)\s/m);
  } finally {
    await server.close();
  }
});

test('source maps in the dev server: the page and early modules map their expressions to the HTML', async () => {
  const devAlias = [{ find: '@tiaforge-ui/sinter/dev', replacement: `${src}/dev.ts` }, ...alias];
  const server = await createServer({ root, logLevel: 'silent', resolve: { alias: devAlias }, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', plugins: [sinter()] });
  try {
    await server.transformIndexHtml('/index.html', readFileSync(join(root, 'index.html'), 'utf8'));
    for (const id of ['/@sinter/index.html.js', '/@sinter/early/index.html.js']) {
      const r = await server.transformRequest(id);
      const map = r?.map as { sources?: string[]; mappings: string } | null | undefined;
      expect(map?.sources, id).toContain(join(root, 'index.html'));
      expect(map?.mappings, id).toMatch(/[A-Za-z]/);
    }
  } finally {
    await server.close();
  }
});

test('source maps in a build with build.sourcemap: the page bundle\'s map lists the HTML', async () => {
  const dir = join(out, 'sourcemap');
  await build({ root, logLevel: 'silent', plugins: [sinter()], resolve: { alias }, build: { outDir: dir, emptyOutDir: true, minify: false, sourcemap: true } });
  const maps = readdirSync(join(dir, 'assets')).filter((f) => f.endsWith('.js.map')).map((f) => JSON.parse(readFileSync(join(dir, 'assets', f), 'utf8')) as { sources: string[] });
  expect(maps.some((m) => m.sources.some((s) => s.endsWith('index.html')))).toBe(true);
});

const i18nRoot = resolve(__dirname, '../fixtures/vite-i18n');
const i18nAlias = [...alias.slice(0, -1), { find: '@tiaforge-ui/sinter/messages', replacement: `${src}/messages.ts` }, alias.at(-1)!];

test('messages: one file per page and language with only the keys it calls (markup and modules), loaded before the first paint', async () => {
  const dir = join(out, 'i18n');
  await build({ root: i18nRoot, logLevel: 'silent', resolve: { alias: i18nAlias }, build: { outDir: dir, emptyOutDir: true, minify: false }, plugins: [sinter({ typecheck: true })] });
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  // the picker starts the shared head script, its data on the tag; the page's own follows
  const h = heads(html, dir);
  expect(h.i18n).not.toBeNull();
  expect(h.own).not.toBeNull();
  expect(h.sharedCode).toContain('/* sinter i18n */');
  expect(html).not.toContain('blocking=');
  const data = h.i18n;
  expect(data).toMatchObject({ base: 'en', locales: ['en', 'de'], storage: 'locale' });
  const lang = (l: string) => readFileSync(join(dir, data.files[l].slice(1)), 'utf8');
  // markup's title, hello, only_en; the config module's bye; not `unused`; German falls back for only_en
  expect(lang('de')).toContain('{"bye":"Tschüss","hello":"Hallo {name}","only_en":"Only in English","title":"Leute"}');
  expect(lang('en')).not.toContain('Never shown');
  // the bundles hold no message text: they read the dictionary the language file left
  const js = readdirSync(join(dir, 'assets')).filter((f) => /^index-(?!en-|de-)/.test(f)).map((f) => readFileSync(join(dir, 'assets', f), 'utf8')).join('\n');
  expect(js).not.toMatch(/People|Leute|Tschüss/);
  expect(js).toContain('await ready()');
  // the base language's text is in the HTML, marked: hidden for other languages until the page module has rendered
  expect(html).toContain('data-sn-m="">People</h1>');
  expect(html).toContain('data-sn-m="">Hello Ada</p>');
  // the app's modules are typed: generated declarations for `m`
  expect(readFileSync(join(i18nRoot, 'src/sinter.messages.d.ts'), 'utf8')).toContain('hello(params: { name: string | number }): string;');
});

test('messages: a page whose markup has no `m` but whose modules call it gets the picker, its language file, and waits for it', async () => {
  const dir = join(out, 'i18n-other');
  await build({ root: i18nRoot, logLevel: 'silent', resolve: { alias: i18nAlias }, build: { outDir: dir, emptyOutDir: true, minify: false, rollupOptions: { input: join(i18nRoot, 'other.html') } }, plugins: [sinter({ typecheck: true })] });
  const html = readFileSync(join(dir, 'other.html'), 'utf8');
  const data = heads(html, dir, 'other').i18n;
  expect(data).not.toBeNull();
  const lang = (l: string) => readFileSync(join(dir, data.files[l].slice(1)), 'utf8');
  // the helper's only_en and the config module's bye; nothing the other page's markup calls
  expect(lang('de')).toContain('{"bye":"Tschüss","only_en":"Only in English"}');
  expect(lang('en')).not.toContain('People');
  // the page bundle renders once the dictionary is there, so farewell() returns text, not the key
  const js = readdirSync(join(dir, 'assets')).filter((f) => /^other-(?!en-|de-)/.test(f)).map((f) => readFileSync(join(dir, 'assets', f), 'utf8')).join('\n');
  expect(js).toMatch(/await ready\(\);\s*use\(mount\(/);
});

test('messages: unknown keys, wrong parameters and `m[key]` in a module fail the build', async () => {
  const page = join(i18nRoot, 'index.html'), mod = join(i18nRoot, 'src/bye.js');
  const [p0, m0] = [readFileSync(page, 'utf8'), readFileSync(mod, 'utf8')];
  const run = () => build({ root: i18nRoot, logLevel: 'silent', resolve: { alias: i18nAlias }, build: { outDir: join(out, 'i18n-bad'), emptyOutDir: true }, plugins: [sinter({ typecheck: true })] });
  try {
    writeFileSync(page, p0.replace('m.title()', 'm.titel()'));
    await expect(run()).rejects.toThrow(/SN206.*`m\.titel` is not exported/s);
    writeFileSync(page, p0.replace('m.hello({ name: who })', 'm.hello({ nom: who })'));
    await expect(run()).rejects.toThrow(/SN208.*'nom' does not exist/s);
    writeFileSync(page, p0);
    writeFileSync(mod, m0.replace('m.bye()', "m['bye']()"));
    await expect(run()).rejects.toThrow(/bye\.js:3:\d+: `m\[…\]`/);
  } finally {
    writeFileSync(page, p0);
    writeFileSync(mod, m0);
    rmSync(join(i18nRoot, '.sinter'), { recursive: true, force: true });
  }
});

test('an app without messages pays nothing: no i18n module, picker or language file in its build', async () => {
  const dir = join(out, 'no-i18n');
  await build({ root, logLevel: 'silent', resolve: { alias }, build: { outDir: dir, emptyOutDir: true }, plugins: [sinter()] });
  const files = readdirSync(join(dir, 'assets'));
  expect(files.filter((f) => /i18n|-(en|de)-/.test(f))).toEqual([]);
  const all = [readFileSync(join(dir, 'index.html'), 'utf8'), ...files.map((f) => readFileSync(join(dir, 'assets', f), 'utf8'))].join('\n');
  expect(all).not.toMatch(/sinter\.i18n|data-sn-i18n|await ready\(\)/);
});
