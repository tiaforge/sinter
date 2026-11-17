// @vitest-environment node
// A component library through the Vite plugin (docs/libraries.md): `@fixture/ui` linked into the app's
// node_modules from outside its root, as a workspace links it. Its scoped styles are in `@layer
// sinter-lib`, declared before the app's stylesheets so the app's layers and unlayered CSS win; a page
// uses its tree with a fill, its card's script runs, its helpers come through the app's namespace.
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, createServer, preview, type PreviewServer } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { chromium } from '../browser.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const UI = resolve(__dirname, '../fixtures/ui');
const root = mkdtempSync(join(tmpdir(), 'sinter-library-app-'));
const out = join(root, 'dist');
afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeAll(() => {
  cpSync(resolve(__dirname, '../fixtures/ui-app'), root, { recursive: true });
  mkdirSync(join(root, 'node_modules/@fixture'), { recursive: true });
  symlinkSync(UI, join(root, 'node_modules/@fixture/ui'), 'dir');
  // the app's own CSS: a layer of its own over the library's color, unlayered padding over the library's
  writeFileSync(join(root, 'src/app.css'), `@layer base, theme;
@layer theme { h2 { color: rgb(9, 9, 9); } }
.card { padding: 4px; }
`);
});

const plugins = () => [sinter({ components: ['@fixture/ui'] })];

test.skipIf(!chromium)('a build: the libraries\' layer is declared first, their scoped styles are in it, the app\'s CSS wins', async () => {
  await build({ root, logLevel: 'silent', plugins: plugins(), resolve: { alias }, build: { outDir: out, emptyOutDir: true, minify: false } });
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  const links = [...html.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]!);
  const sheets = links.map((h) => readFileSync(join(out, h), 'utf8'));
  // the page's stylesheet starts by declaring the layer; the app's CSS comes after it
  expect(sheets[0]!.startsWith('@layer sinter-lib;\n')).toBe(true);
  const all = sheets.join('\n');
  expect(all.indexOf('@layer sinter-lib;')).toBeLessThan(all.indexOf('@layer base, theme;'));
  // the library's scoped styles, inside the layer; nothing of the app's own components in it
  expect(all).toMatch(/@layer sinter-lib \{\s*@scope \(\[data-sn-c="ui-card"\], \[data-sn-s="ui-card"\]\) to \(\[data-sn-c\], \[data-sn-s\]\)/);
  expect(all).toMatch(/@layer sinter-lib \{\s*@scope \(\[data-sn-c="ui-tree"\]/);
  const browser = await chromium!.launch();
  let server: PreviewServer | null = null;
  try {
    server = await preview({ root, logLevel: 'silent', build: { outDir: out }, preview: { port: 0 } });
    const url = server.resolvedUrls!.local[0]!;
    const tab = await browser.newPage();
    const errors: string[] = [];
    tab.on('pageerror', (e) => errors.push(e.message));
    await tab.goto(url);
    await tab.waitForSelector('.card[data-ready]');
    const style = (sel: string) => tab.$eval(sel, (el) => { const s = getComputedStyle(el); return { color: s.color, pad: s.padding }; });
    // unlayered app CSS over the library's padding; the app's `theme` layer over the library's color
    expect(await style('.card')).toEqual({ color: expect.any(String), pad: '4px' });
    expect((await style('.card h2')).color).toBe('rgb(9, 9, 9)');
    // the card's script ran (it marks its root with the title), the app's helper and the namespace's
    expect(await tab.$eval('.card', (el) => (el as HTMLElement).dataset.ready)).toBe('ADA LOVELACE');
    expect(await tab.textContent('.by')).toBe('AL');
    expect(await tab.textContent('#count')).toBe('2');
    // the tree: the page's fill at every depth, with the data its placement passes
    expect(await tab.$$eval('.tree .pick', (els) => els.map((e) => e.textContent))).toEqual(['root', 'leaf']);
    await tab.click('.tree li li .pick');
    expect(await tab.textContent('#picked')).toBe('2');
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await new Promise<void>((r) => (server ? server.httpServer.close(() => r()) : r()));
  }
}, 120_000);

test.skipIf(!chromium)('a package namespace by its declaring modules: the plain member is in the page, the lazy one\'s module loads with its package when the let needs it', async () => {
  const lroot = join(root, 'lazy-app');
  cpSync(resolve(__dirname, '../fixtures/ui-app'), lroot, { recursive: true });
  mkdirSync(join(lroot, 'node_modules/@fixture'), { recursive: true });
  symlinkSync(UI, join(lroot, 'node_modules/@fixture/ui'), 'dir');
  writeFileSync(join(lroot, 'index.html'), `<!doctype html><html><head><title>words</title></head><body>
<div data-sn-state="{ items: [{ id: 1, label: 'root', children: [{ id: 2, label: 'leaf' }] }], s: 'one two three' }">
  <p id="o" data-sn-text="ui.outline(items).join(', ')"></p>
  <p id="w" data-sn-let="{ w: ui.words(s) }" data-sn-text="w ? w.length : 'waiting'"></p>
</div></body></html>`);
  const lout = join(lroot, 'dist');
  await build({ root: lroot, logLevel: 'silent', plugins: [sinter({ components: ['@fixture/ui'], lazy: ['@fixture/heavy'] })], resolve: { alias }, build: { outDir: lout, emptyOutDir: true, minify: false } });
  const html = readFileSync(join(lout, 'index.html'), 'utf8');
  const entry = html.match(/<script type="module"[^>]*src="([^"]+)"/)![1]!;
  const files = readdirSync(join(lout, 'assets')).filter((f) => f.endsWith('.js'));
  const heavy = files.filter((f) => readFileSync(join(lout, 'assets', f), 'utf8').includes('FIXTURE_HEAVY_BODY'));
  // the package is a chunk of its own, and not the page's entry; the plain member's code is in the page
  expect(heavy.length).toBe(1);
  expect(entry).not.toContain(heavy[0]!);
  const page = readFileSync(join(lout, entry), 'utf8');
  expect(page).toContain('flatMap');
  expect(page).not.toContain('FIXTURE_HEAVY_BODY');
  expect(html).not.toContain(heavy[0]!);
  const browser = await chromium!.launch();
  let server: PreviewServer | null = null;
  try {
    server = await preview({ root: lroot, logLevel: 'silent', build: { outDir: lout }, preview: { port: 0 } });
    const tab = await browser.newPage();
    const errors: string[] = [];
    tab.on('pageerror', (e) => errors.push(e.message));
    const loaded: string[] = [];
    tab.on('request', (r) => { if (r.url().includes(heavy[0]!)) loaded.push(r.url()); });
    await tab.goto(server.resolvedUrls!.local[0]!);
    await tab.waitForFunction(() => document.querySelector('#w')?.textContent === '3');
    expect(await tab.textContent('#o')).toBe('root, leaf');
    expect(loaded.length).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await new Promise<void>((r) => (server ? server.httpServer.close(() => r()) : r()));
  }
}, 120_000);

test.skipIf(!chromium)('the library itself in `lazy`, and a page that calls another helper of the app at run time: the helpers module\'s re-export of the library is dropped, not refused', async () => {
  // the markdown library's setup (`lazy: ['@tiaforge-ui/sinter-markdown']`) in an app whose pages also
  // call its own helpers in the browser: the page module imports the helpers module, whose
  // `export * as ui from '@fixture/ui'` re-exports a lazy package. Pages import each member from the
  // module that declares it, so the barrel's copy goes, and with it the package's eager load.
  const lroot = join(root, 'lazy-barrel-app');
  cpSync(resolve(__dirname, '../fixtures/ui-app'), lroot, { recursive: true });
  mkdirSync(join(lroot, 'node_modules/@fixture'), { recursive: true });
  symlinkSync(UI, join(lroot, 'node_modules/@fixture/ui'), 'dir');
  // a helper that reads the browser (RealWorld's signedOut): it runs on the page, never at build time
  writeFileSync(join(lroot, 'src/sinter.helpers.ts'), `export * as ui from '@fixture/ui';\nexport const here = (): string => location.pathname;\n`);
  writeFileSync(join(lroot, 'index.html'), `<!doctype html><html><head><title>words</title></head><body>
<div data-sn-state="{ items: [{ id: 1, label: 'root', children: [] }], s: 'one two three' }">
  <p id="s" data-sn-text="here()"></p>
  <p id="o" data-sn-text="ui.outline(items).join(', ')"></p>
  <p id="w" data-sn-let="{ w: ui.words(s) }" data-sn-text="w ? w.length : 'waiting'"></p>
</div></body></html>`);
  const lout = join(lroot, 'dist');
  await build({ root: lroot, logLevel: 'silent', plugins: [sinter({ components: ['@fixture/ui'], lazy: ['@fixture/ui', '@fixture/heavy'] })], resolve: { alias }, build: { outDir: lout, emptyOutDir: true, minify: false } });
  const html = readFileSync(join(lout, 'index.html'), 'utf8');
  const entry = html.match(/<script type="module"[^>]*src="([^"]+)"/)![1]!;
  const files = readdirSync(join(lout, 'assets')).filter((f) => f.endsWith('.js'));
  const heavy = files.filter((f) => readFileSync(join(lout, 'assets', f), 'utf8').includes('FIXTURE_HEAVY_BODY'));
  expect(heavy.length).toBe(1);
  expect(readFileSync(join(lout, entry), 'utf8')).not.toContain('FIXTURE_HEAVY_BODY');
  expect(html).not.toContain(heavy[0]!);
  const browser = await chromium!.launch();
  let server: PreviewServer | null = null;
  try {
    server = await preview({ root: lroot, logLevel: 'silent', build: { outDir: lout }, preview: { port: 0 } });
    const tab = await browser.newPage();
    const errors: string[] = [];
    tab.on('pageerror', (e) => errors.push(e.message));
    await tab.goto(server.resolvedUrls!.local[0]!);
    await tab.waitForFunction(() => document.querySelector('#w')?.textContent === '3');
    expect(await tab.textContent('#s')).toBe('/');
    expect(await tab.textContent('#o')).toBe('root');
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await new Promise<void>((r) => (server ? server.httpServer.close(() => r()) : r()));
  }
}, 120_000);

test('dev: the library is left out of dependency pre-bundling, served through the link and watched', async () => {
  const server = await createServer({ root, logLevel: 'silent', plugins: plugins(), resolve: { alias }, server: { port: 0, hmr: false }, optimizeDeps: { noDiscovery: true } });
  try {
    expect(server.config.optimizeDeps.exclude).toContain('@fixture/ui');
    // its real folder, outside the root, may be served
    expect(server.config.server.fs.allow).toContain(UI);
    await server.listen();
    const base = server.resolvedUrls!.local[0]!.replace(/\/$/, '');
    const html = await (await fetch(base + '/')).text();
    expect(html).toContain('data-sn-c="ui-card"');
    // the card's script, through node_modules, and its generated base class
    const mod = new URL(html.match(/<script type="module" src="([^"]*sinter[^"]*)"/)![1]!, base + '/').pathname;
    const page = await (await fetch(base + mod)).text();
    const script = page.match(/["']([^"']*ui-card\.ts)["']/)?.[1];
    expect(script).toBeDefined();
    const res = await fetch(base + script);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/UiCardComponent/);
    // a library component's HTML is watched where it really is: a change reaches the next compile
    expect(server.watcher.getWatched()[resolve(UI, 'sinter/components')]).toContain('ui-card.html');
  } finally {
    await server.close();
  }
}, 120_000);

