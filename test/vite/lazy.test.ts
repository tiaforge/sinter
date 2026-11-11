// @vitest-environment node
// Lazy packages through the Vite plugin (docs/lazy.md): the package is a chunk of its own that no
// page imports statically, loaded on the first call; a removed chunk is a stale page (`$error.stale`).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { chromium } from '../browser.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const root = mkdtempSync(join(tmpdir(), 'sinter-lazy-app-'));
const out = join(root, 'dist');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const put = (f: string, s: string) => { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), s); };
/** the package's own code: a marker that shows where it was bundled */
const MARK = 'FAKEPGP_' + 'BODY';

beforeAll(async () => {
  put('node_modules/fakepgp/package.json', JSON.stringify({ name: 'fakepgp', version: '1.0.0', type: 'module', main: 'index.js' }));
  put('node_modules/fakepgp/index.js', `const body = '${MARK}'.repeat(200);
export async function encrypt(t) { return 'enc(' + t + ')'; }
export function parse(t) { return 'parse(' + t + ')' + body.length; }
export const enums = { aes: 1 };
export class Thing { say(n) { return 'thing ' + n; } }
`);
  // a component built around one of the package's classes: its script loads with the package
  put('src/components/x-ring.html', `<template data-sn-component="{ n: number }"><p data-sn-state="{ said: '' }"><span data-sn-text="said"></span></p></template>\n`);
  put('src/components/x-ring.ts', `import { XRingComponent } from './x-ring.html';
import { Thing } from 'fakepgp';
export class XRing extends XRingComponent {
  t = new Thing();
  connected() { this.state.said = this.t.say(this.props.n); (window as any).__conn = ((window as any).__conn ?? 0) + 1; }
  propsChanged() { this.state.said = this.t.say(this.props.n); }
}
`);
  put('comp.html', `<!doctype html><html><head><title>comp</title></head><body>
<div data-sn-state="{ n: 1, show: true }" data-sn-preload="fakepgp">
  <template data-sn-if="show"><div id="a"><x-ring data-sn-prop="{ n }"></x-ring></div></template>
  <div id="b"><x-ring data-sn-prop="{ n }"></x-ring></div>
  <button id="inc" data-sn-on-click="n = n + 1">inc</button>
  <button id="hide" data-sn-on-click="show = false">hide</button>
</div>
</body></html>`);
  put('src/sinter.actions.ts', `export * as pgp from './actions/pgp.ts';\n`);
  put('src/actions/pgp.ts', `import * as fake from 'fakepgp';
import type { enums } from 'fakepgp';
export async function seal(t: string) { return (await fake.encrypt(t)) + ':' + (await fake.parse(t)); }
`);
  put('index.html', `<!doctype html><html><head><title>lazy</title></head><body>
<div data-sn-state="{ out: '', err: '' }">
  <button id="go" data-sn-call="pgp.seal('hi')" data-sn-then="out = $result" data-sn-catch="err = $error.stale ? 'stale: ' + $error.message : 'other: ' + $error.message">go</button>
  <output id="out" data-sn-text="out"></output>
  <output id="err" data-sn-text="err"></output>
</div>
</body></html>`);
  // loaded when an element renders, and fetched with the page
  put('import.html', `<!doctype html><html><head><title>import</title></head><body>
<main data-sn-import="fakepgp"><p>reader</p></main>
</body></html>`);
  put('preload.html', `<!doctype html><html><head><title>preload</title></head><body>
<div data-sn-state="{ out: '' }"><button id="go" data-sn-call="pgp.seal('hi')" data-sn-then="out = $result" data-sn-preload="fakepgp">go</button><output id="out" data-sn-text="out"></output></div>
</body></html>`);
  const input = { index: join(root, 'index.html'), import: join(root, 'import.html'), preload: join(root, 'preload.html'), comp: join(root, 'comp.html') };
  await build({ root, logLevel: 'silent', plugins: [sinter({ lazy: ['fakepgp'] })], resolve: { alias }, build: { outDir: out, emptyOutDir: true, minify: false, rollupOptions: { input } } });
}, 60_000);

const assets = () => readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.js'));
const read = (f: string) => readFileSync(join(out, 'assets', f), 'utf8');
/** the chunk the loader imports (and asks the server about when a load fails), and the one with the package's code */
const lazyChunks = () => {
  const code = assets().map(read).join('\n');
  const target = /lazy\(\(\) => __vitePreload\(\(\) => import\("\.\/([^"]+)"\)/.exec(code)![1]!;
  return { target, body: assets().find((f) => read(f).includes(MARK))! };
};

test('the package is a chunk of its own, which the page bundle does not import statically', () => {
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  const entry = /<script type="module" crossorigin src="\/assets\/([^"]+)"/.exec(html)![1]!;
  const statics = new Set<string>(), todo = [entry];
  while (todo.length) {
    const f = todo.pop()!;
    if (statics.has(f)) continue;
    statics.add(f);
    for (const m of read(f).matchAll(/^import\s[^'"]*["']\.\/([^"']+)["']/gm)) todo.push(m[1]!);
  }
  expect(assets().filter((f) => read(f).includes(MARK))).toHaveLength(1);
  const { target, body } = lazyChunks();
  expect(statics.has(target) || statics.has(body)).toBe(false);
  // nor a modulepreload of it
  expect(html).not.toContain(target);
  expect(html).not.toContain(body);
  // the loader knows the chunk's URL, for the stale check
  const code = assets().map(read).join('\n');
  expect(code).not.toMatch(/["']__SN_CHUNK__[/\\]/);
  expect(code).toMatch(new RegExp(`lazy\\(\\(\\) => [\\s\\S]{0,200}"\\./${target.replace(/[.]/g, '\\.')}", import\\.meta\\.url\\)`));
});

test.skipIf(!chromium)('the first call loads the package; a removed chunk is a stale page', async () => {
  let server: PreviewServer | null = null;
  const browser = await chromium!.launch();
  try {
    server = await preview({ root, logLevel: 'silent', preview: { port: 0 }, build: { outDir: out } });
    const url = server.resolvedUrls!.local[0]!;
    const { target: pkg, body } = lazyChunks();
    const tab = await browser.newPage();
    const requested: string[] = [];
    tab.on('request', (r) => requested.push(r.url()));
    await tab.goto(url);
    await tab.waitForFunction(() => document.documentElement.hasAttribute('data-sn-ready') || !!document.querySelector('#go'));
    await tab.waitForTimeout(300);
    expect(requested.some((u) => u.endsWith(pkg))).toBe(false);
    await tab.click('#go');
    await tab.waitForFunction(() => document.querySelector('#out')?.textContent !== '');
    expect(await tab.textContent('#out')).toBe(`enc(hi):parse(hi)${'FAKEPGP_BODY'.length * 200}`);
    expect(requested.some((u) => u.endsWith(pkg))).toBe(true);

    // a deploy removed the chunk: a fresh tab of the old page fails with `stale`
    const kept = [pkg, body].map((f) => [f, read(f)] as const);
    for (const [f] of kept) unlinkSync(join(out, 'assets', f));
    try {
      const tab2 = await browser.newPage();
      await tab2.goto(url);
      await tab2.waitForTimeout(300);
      await tab2.click('#go');
      await tab2.waitForFunction(() => document.querySelector('#err')?.textContent !== '');
      expect(await tab2.textContent('#err')).toBe('stale: this page is out of date: reload it');
    } finally {
      for (const [f, text] of kept) writeFileSync(join(out, 'assets', f), text);
    }
  } finally {
    await browser.close();
    if (server) await new Promise((r) => server!.httpServer.close(r));
  }
}, 60_000);

test('data-sn-preload: a modulepreload link for the package\'s chunk, in the page\'s head', () => {
  const { target: pkg, body } = lazyChunks();
  const html = readFileSync(join(out, 'preload/index.html'), 'utf8');
  // the chunk the loader imports, then the chunks it imports, at the end of the head
  expect(html).toMatch(new RegExp(`<link rel="modulepreload" crossorigin href="/assets/${pkg.replace(/[.]/g, '\\.')}">\\s*<link rel="modulepreload" crossorigin href="/assets/${body.replace(/[.]/g, '\\.')}">\\s*</head>`));
  expect(html).not.toContain('data-sn-preload');
  expect(readFileSync(join(out, 'import/index.html'), 'utf8')).not.toContain(pkg);
});

test.skipIf(!chromium)('data-sn-import: the package loads once the page has taken over, with no call', async () => {
  const server = await preview({ root, logLevel: 'silent', preview: { port: 0 }, build: { outDir: out } });
  const browser = await chromium!.launch();
  try {
    const { target: pkg } = lazyChunks();
    const tab = await browser.newPage();
    const requested: string[] = [];
    tab.on('request', (r) => requested.push(r.url()));
    await tab.goto(server.resolvedUrls!.local[0]! + 'import.html');
    await tab.waitForFunction((p) => performance.getEntriesByType('resource').some((e) => e.name.endsWith(p)), pkg);
    expect(requested.some((u) => u.endsWith(pkg))).toBe(true);
  } finally {
    await browser.close();
    await new Promise((r) => server.httpServer.close(r));
  }
}, 60_000);

test('a component script that imports a lazy package is a chunk of its own, beside the package\'s', () => {
  const html = readFileSync(join(out, 'comp/index.html'), 'utf8');
  const entry = /<script type="module" crossorigin src="\/assets\/([^"]+)"/.exec(html)![1]!;
  const script = assets().find((f) => f.startsWith('x-ring-'))!;
  expect(script).toBeDefined();
  expect(read(script)).not.toContain(MARK);
  // data-sn-preload: the package, and the page's component scripts that load with it
  expect(html).toContain(`<link rel="modulepreload" crossorigin href="/assets/${script}">`);
  expect(html).toContain(`<link rel="modulepreload" crossorigin href="/assets/${lazyChunks().body}">`);
  expect(read(entry)).toMatch(new RegExp(`later\\(\\(\\) => __vitePreload\\(\\(\\) => import\\("\\./${script.replace(/[.]/g, '\\.')}"[\\s\\S]{0,200}"\\./${script.replace(/[.]/g, '\\.')}", import\\.meta\\.url\\)`));
});

test.skipIf(!chromium)('a lazy component script: the instance starts once it and the package have loaded, with the latest props; one removed meanwhile never does', async () => {
  const server = await preview({ root, logLevel: 'silent', preview: { port: 0 }, build: { outDir: out } });
  const browser = await chromium!.launch();
  try {
    const tab = await browser.newPage();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const pkg = assets().find((f) => read(f).includes(MARK))!;
    await tab.route(`**/assets/${pkg}`, async (route) => { await held; await route.continue(); });
    await tab.goto(server.resolvedUrls!.local[0]! + 'comp/');
    await tab.waitForTimeout(200);
    await tab.click('#inc');
    await tab.click('#hide');
    expect(await tab.textContent('#b span')).toBe('');
    release();
    await tab.waitForFunction(() => document.querySelector('#b span')?.textContent === 'thing 2');
    expect(await tab.evaluate(() => (window as any).__conn)).toBe(1);
    expect(await tab.$('#a')).toBeNull();
    await tab.click('#inc');
    await tab.waitForFunction(() => document.querySelector('#b span')?.textContent === 'thing 3');
  } finally {
    await browser.close();
    await new Promise((r) => server.httpServer.close(r));
  }
}, 60_000);

test('SN324 fails the build at the use', async () => {
  const bad = mkdtempSync(join(tmpdir(), 'sinter-lazy-bad-'));
  try {
    mkdirSync(join(bad, 'src/actions'), { recursive: true });
    mkdirSync(join(bad, 'node_modules/fakepgp'), { recursive: true });
    writeFileSync(join(bad, 'node_modules/fakepgp/package.json'), JSON.stringify({ name: 'fakepgp', type: 'module', main: 'index.js' }));
    writeFileSync(join(bad, 'node_modules/fakepgp/index.js'), 'export const enums = {}; export async function encrypt() {}');
    writeFileSync(join(bad, 'src/sinter.actions.ts'), `import * as fake from 'fakepgp';\nexport function go() { fake.encrypt(); return fake.enums; }\n`);
    writeFileSync(join(bad, 'index.html'), '<!doctype html><html><head><title>x</title></head><body><button data-sn-call="go()">x</button></body></html>');
    const err = await build({ root: bad, logLevel: 'silent', plugins: [sinter({ lazy: ['fakepgp'] })], resolve: { alias }, build: { outDir: join(bad, 'dist'), emptyOutDir: true } }).then(() => null, (e: Error) => e.message);
    expect(err).toContain('SN324 src/sinter.actions.ts:2:24 `fake.encrypt(…)` is not awaited');
    expect(err).toContain('SN324 src/sinter.actions.ts:2:47 `fake.enums` needs fakepgp loaded at once');
  } finally {
    rmSync(bad, { recursive: true, force: true });
  }
}, 60_000);
