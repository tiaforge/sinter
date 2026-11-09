// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, createServer, preview } from 'vite';
import { afterAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';

const root = resolve(__dirname, '../fixtures/vite-app');
const src = resolve(__dirname, '../../src');
const out = mkdtempSync(join(tmpdir(), 'sinter-vite-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

const alias = ['sse', 'optimistic', 'paginate', 'persist', 'early', 'prefetch', 'transition']
  .map((f) => ({ find: `@tiaforge-ui/sinter/${f}`, replacement: `${src}/${f}.ts` }))
  .concat([{ find: '@tiaforge-ui/sinter', replacement: `${src}/index.ts` }]);

async function run(outDir: string) {
  return build({ root, logLevel: 'silent', plugins: [sinter()], resolve: { alias }, build: { outDir, emptyOutDir: true, minify: false } });
}

test('builds a page: rewritten HTML, page module, helpers, namespace members and called actions', async () => {
  await run(out);
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  // no directive is left; the paint script's marker is the build's own (a page with an early file and no messages)
  expect(html).toMatch(/<script src="\/assets\/sinter-paint-[\w-]+\.js" data-sn-early><\/script>\s*<script type="module" crossorigin src="\/assets\/index-early-[\w-]+\.js" blocking="render">/);
  expect(html.replace(' data-sn-early>', '>')).not.toContain('data-sn-');
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
    expect(html).not.toContain('data-sn-prefetch');
  } finally {
    writeFileSync(page, original);
  }
});

test('`speculation: { delivery: \'header\' }`: a rules file at the site root, no inline script; `vite preview` sends the header and its type', async () => {
  const dir = join(out, 'header');
  const config = { root, logLevel: 'silent' as const, resolve: { alias }, build: { outDir: dir, emptyOutDir: true, minify: false }, plugins: [sinter({ speculation: { mode: 'prefetch', delivery: 'header' } })] };
  await build(config);
  expect(readFileSync(join(dir, 'index.html'), 'utf8')).not.toContain('speculationrules');
  expect(JSON.parse(readFileSync(join(dir, 'speculation-rules.json'), 'utf8')).prefetch[0].where.and[0].href_matches).toEqual(['/\\?*#*', '/index.html\\?*#*']);
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

test('a page that uses data-sn-transition gets the hold script before its page module; others do not', async () => {
  const page = join(root, 'index.html');
  const original = readFileSync(page, 'utf8');
  const plain = readFileSync(join(out, 'index.html'), 'utf8');
  expect(plain).not.toContain('sinter-hold-');
  writeFileSync(page, original.replace('<input data-sn-model="q">', '<input data-sn-model="q"><h2 data-sn-transition="\'people\'">People</h2>'));
  try {
    const dir = join(out, 'hold');
    await build({ root, logLevel: 'silent', resolve: { alias }, build: { outDir: dir, emptyOutDir: true, minify: false }, plugins: [sinter()] });
    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    const hold = html.search(/<script src="\/assets\/sinter-hold-[\w-]+\.js"><\/script>/), module = html.search(/<script type="module" crossorigin src="\/assets\/index-[\w-]+\.js" async>/);
    expect(hold).toBeGreaterThan(0);
    expect(hold).toBeLessThan(module);
    expect(readdirSync(join(dir, 'assets')).some((f) => f.startsWith('sinter-hold-'))).toBe(true);
  } finally {
    writeFileSync(page, original);
  }
});

test('Speculation Rules: every page gets them for the app\'s paths; `speculation: false` leaves them out', async () => {
  await run(out);
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  const rules = JSON.parse(/<script type="speculationrules">(.*?)<\/script>/.exec(html)![1]!);
  expect(rules.prefetch[0].where.and[0].href_matches).toEqual(['/\\?*#*', '/index.html\\?*#*']);
  const dir = join(out, 'no-speculation');
  await build({ root, logLevel: 'silent', resolve: { alias }, build: { outDir: dir, emptyOutDir: true, minify: false }, plugins: [sinter({ speculation: false })] });
  expect(readFileSync(join(dir, 'index.html'), 'utf8')).not.toContain('speculationrules');
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

test('first paint: one self-contained early file per page, render-blocking before the page module', async () => {
  const dir = join(out, 'first-paint');
  const logs: string[] = [];
  await build({
    root, resolve: { alias }, build: { outDir: dir, emptyOutDir: true, minify: false },
    customLogger: { info: (m: string) => { logs.push(m); }, warn: (m: string) => { logs.push(m); }, warnOnce: () => {}, error: () => {}, clearScreen: () => {}, hasErrorLogged: () => false, hasWarned: false } as never,
    plugins: [sinter({ earlyBudget: 1 })],
  });
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  const early = /<script type="module" crossorigin src="\/assets\/(index-early-[\w-]+\.js)" blocking="render"><\/script>/.exec(html);
  expect(early).not.toBeNull();
  const page = /<script type="module" crossorigin src="\/assets\/(index-[\w-]+\.js)" async><\/script>/.exec(html);
  expect(page).not.toBeNull();
  expect(html.indexOf(early![0])).toBeLessThan(html.indexOf(page![0]));
  const code = readFileSync(join(dir, 'assets', early![1]!), 'utf8');
  // everything in one file: the app's early module, the early runtime, the message the early binding calls
  expect(code).not.toMatch(/^\s*import\b|\bimport\(/m);
  expect(code).toMatch(/dataset\.early = ["']yes["']/);
  expect(code).toContain('People');
  expect(code).toContain('not available early');
  // not the page's other helpers, nor the runtime
  expect(code).not.toContain('toUpperCase');
  expect(code).not.toContain('mount(');
  // the page module (async) mounts once the early file has rendered
  expect(readFileSync(join(dir, 'assets', page![1]!), 'utf8')).toMatch(/await rendered\(\);[\s\S]*mount\(document/);
  // the build reports the early file's size, and warns over the budget with the largest modules
  expect(logs.find((l) => l.includes('early file of index.html'))).toMatch(/early file of index\.html: assets\/index-early-[\w-]+\.js [\d.]+ kB gzip, over the early budget of 0\.0 kB.*Largest \(before gzip\): /s);
  // `firstPaint: false`: everything waits for the page module
  await build({ root, logLevel: 'silent', resolve: { alias }, build: { outDir: join(dir, 'off'), emptyOutDir: true, minify: false }, plugins: [sinter({ firstPaint: false })] });
  const off = readFileSync(join(dir, 'off', 'index.html'), 'utf8');
  expect(off).not.toContain('early');
  expect(off).not.toContain('blocking');
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
  const file = /src="\/assets\/(index-early-[\w-]+\.js)" blocking="render"/.exec(html)![1]!;
  const code = readFileSync(join(dir, 'assets', file), 'utf8');
  expect(code).toContain('lazy-early-module');            // in the early file itself
  expect(code).not.toMatch(/^\s*import\s|\bimport\(/m);  // which loads nothing (Vite's preload helper reads import.meta)
  expect(said.join('\n')).not.toMatch(/inlineDynamicImports|codeSplitting/);
});

test('first paint in the dev server: the early chunk as a module of its own, before the page module', async () => {
  const server = await createServer({ root, logLevel: 'silent', resolve: { alias }, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', plugins: [sinter()] });
  try {
    const html = await server.transformIndexHtml('/index.html', readFileSync(join(root, 'index.html'), 'utf8'));
    expect(html).toMatch(/<script type="module" src="\/@sinter\/early\/index\.html\.js" blocking="render"><\/script><script type="module" src="\/@sinter\/index\.html\.js"><\/script>/);
    const js = await server.transformRequest('/@sinter/early/index.html.js');
    expect(js?.code).toContain('sinter.early.js');
  } finally {
    await server.close();
  }
});

const i18nRoot = resolve(__dirname, '../fixtures/vite-i18n');
const i18nAlias = [...alias.slice(0, -1), { find: '@tiaforge-ui/sinter/messages', replacement: `${src}/messages.ts` }, alias.at(-1)!];

test('messages: one file per page and language with only the keys it calls (markup and modules), loaded before the first paint', async () => {
  const dir = join(out, 'i18n');
  await build({ root: i18nRoot, logLevel: 'silent', resolve: { alias: i18nAlias }, build: { outDir: dir, emptyOutDir: true, minify: false }, plugins: [sinter({ typecheck: true })] });
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  const picker = /<script src="\/assets\/(sinter-i18n-[\w-]+\.js)" data-sn-i18n="([^"]+)" data-sn-early><\/script>\s*<script type="module" crossorigin src="\/assets\/index-early-[\w-]+\.js" blocking="render">/.exec(html);
  expect(picker).not.toBeNull();
  const data = JSON.parse(picker![2]!.replace(/&#34;/g, '"'));
  expect(data).toMatchObject({ base: 'en', locales: ['en', 'de'], storage: 'locale' });
  const lang = (l: string) => readFileSync(join(dir, data.files[l].slice(1)), 'utf8');
  // markup's title, hello, only_en; the config module's bye; not `unused`; German falls back for only_en
  expect(lang('de')).toContain('{"bye":"Tschüss","hello":"Hallo {name}","only_en":"Only in English","title":"Leute"}');
  expect(lang('en')).not.toContain('Never shown');
  // the bundles hold no message text: they read the dictionary the language file left
  const js = readdirSync(join(dir, 'assets')).filter((f) => /^index-(?!en-|de-)/.test(f)).map((f) => readFileSync(join(dir, 'assets', f), 'utf8')).join('\n');
  expect(js).not.toMatch(/People|Leute|Tschüss/);
  expect(js).toContain('await ready()');
  // the app's modules are typed: generated declarations for `m`
  expect(readFileSync(join(i18nRoot, 'src/sinter.messages.d.ts'), 'utf8')).toContain('hello(params: { name: string | number }): string;');
});

test('messages: a page whose markup has no `m` but whose modules call it gets the picker, its language file, and waits for it', async () => {
  const dir = join(out, 'i18n-other');
  await build({ root: i18nRoot, logLevel: 'silent', resolve: { alias: i18nAlias }, build: { outDir: dir, emptyOutDir: true, minify: false, rollupOptions: { input: join(i18nRoot, 'other.html') } }, plugins: [sinter({ typecheck: true })] });
  const html = readFileSync(join(dir, 'other.html'), 'utf8');
  const picker = /<script src="\/assets\/sinter-i18n-[\w-]+\.js" data-sn-i18n="([^"]+)"( data-sn-early)?><\/script>/.exec(html);
  expect(picker).not.toBeNull();
  const data = JSON.parse(picker![1]!.replace(/&#34;/g, '"'));
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
