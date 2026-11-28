// @vitest-environment node
// A built page whose state has a field a helper computed at build time (written into the page, `$.$d(id)`): the early
// script makes the state as it starts, so the value must be parsed by then. The compiler writes the values the early
// file reads first in the head, and the early script comes after them: a build's head scripts, and the dev server's
// early script. Checked on the built files themselves, and on the dev server's page: jsdom parses the page and runs its
// classic head scripts where they stand, as a browser does (the page module, a module script, does not run: the first paint).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createServer as httpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { build, createServer, type Plugin } from 'vite';
import { afterAll, describe, expect, test } from 'vitest';
import sinter from '../../src/vite.js';

// (jsdom ships no types: what this test uses of it)
type Dom = { window: Window & typeof globalThis };
const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string | Uint8Array, options: { url: string; runScripts: 'dangerously'; pretendToBeVisual: boolean; beforeParse(window: Dom['window']): void }) => Dom };

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?([\w-]+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const tmp = mkdtempSync(join(tmpdir(), 'sinter-early-values-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const HELPERS = 'export const titled = (s: string): string => s.replace(/\\b\\w/g, (c) => c.toUpperCase());\n';
// `title` is computed at build time (and changed by a click, so it is read where it is shown); `done` starts true (its
// branch closed, its else shown); `pinned` is a stored choice
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body>
<main data-sn-state="{ pinned: false, done: true, title: titled('hello world') }">
  <input id="pin" type="checkbox" data-sn-model="pinned" data-sn-persist="pinned"><button data-sn-on-click="done = !done; title = title + '!'">t</button>
  <template data-sn-if="!done"><p id="todo">to do</p></template><template data-sn-else><p id="fine">done</p></template>
  <template data-sn-if="!done"><p id="todo2">to do</p></template>
  <template data-sn-if="pinned"><h1 data-sn-text="title"></h1></template>
</main></body></html>
`;

async function site(name: string, options: Parameters<typeof sinter>[0] = {}) {
  const root = join(tmp, name), out = join(root, 'dist');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/sinter.helpers.ts'), HELPERS);
  writeFileSync(join(root, 'index.html'), PAGE);
  await build({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter(options)], build: { outDir: out, emptyOutDir: true, rollupOptions: { input: { index: join(root, 'index.html') } } } });
  return { out, html: readFileSync(join(out, 'index.html'), 'utf8') };
}

/**
 * The built page parsed with its head scripts run where they stand, the stored values given: the document at
 * DOMContentLoaded. The scripts' code is written into their tags, as jsdom runs an inline classic script when the parser
 * reaches it, with only what is before it parsed (an external one it would run after the whole parse).
 */
async function firstPaint(out: string, html: string, stored: Record<string, string>, bytes = false) {
  const inlined = html.replace(/<script src="(\/assets\/[^"]+)"><\/script>/g, (_, src: string) => `<script>${readFileSync(join(out, src), 'utf8').replace(/<\/script/gi, '<\\/script')}</script>`);
  expect(inlined).not.toBe(html);
  return parsed(inlined, stored, bytes);
}

/** a page whose classic scripts are written into their tags, parsed by jsdom with the stored values given: the document at DOMContentLoaded */
async function parsed(inlined: string, stored: Record<string, string>, bytes = false) {
  const errors: string[] = [];
  const dom = new JSDOM(bytes ? Buffer.from(inlined) : inlined, {
    url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      for (const [k, v] of Object.entries(stored)) window.localStorage.setItem(k, v);
      window.addEventListener('error', (e) => errors.push(String(e.message)));
    },
  });
  if (dom.window.document.readyState == 'loading') await new Promise((ok) => dom.window.document.addEventListener('DOMContentLoaded', ok));
  // (the early script's last pass is its own DOMContentLoaded listener)
  await new Promise((ok) => setTimeout(ok, 0));
  return { document: dom.window.document, errors };
}

test('the values the early file reads are in the head before the head scripts, and the first paint has the state they are part of', async () => {
  const { out, html } = await site('values');
  // a first visit: the branch over `done` is closed and its else shown, the stored choice off
  const fresh = await firstPaint(out, html, {});
  expect(fresh.errors).toEqual([]);
  expect([!!fresh.document.querySelector('#todo'), !!fresh.document.querySelector('#fine'), !!fresh.document.querySelector('#todo2'), !!fresh.document.querySelector('h1')]).toEqual([false, true, false, false]);
  // with the stored choice: the build's value is shown, and nothing is painted that the page module would take out again
  const stored = await firstPaint(out, html, { 'sn:pinned': 'true' });
  expect(stored.errors).toEqual([]);
  expect(stored.document.querySelector('h1')?.textContent).toBe('Hello World');
  expect((stored.document.querySelector('#pin') as HTMLInputElement).checked).toBe(true);
  expect([!!stored.document.querySelector('#todo'), !!stored.document.querySelector('#fine'), !!stored.document.querySelector('#todo2')]).toEqual([false, true, false]);  // where the build put it: in the head, before the head scripts
  const head = html.slice(0, html.indexOf('</head>'));
  const value = /<script type="application\/json" data-sn="\d+">"Hello World"<\/script>/.exec(head);
  expect(value).not.toBeNull();
  expect(value!.index).toBeLessThan(head.indexOf('<script src='));
});

test('with the HTML left as written (`minifyHtml: false`) the values are placed the same', async () => {
  const { out, html } = await site('plain', { minifyHtml: false });
  expect(html.indexOf('"Hello World"</script>')).toBeLessThan(html.indexOf('<script src='));
  const stored = await firstPaint(out, html, { 'sn:pinned': 'true' });
  expect(stored.document.querySelector('h1')?.textContent).toBe('Hello World');
  expect(!!stored.document.querySelector('#todo')).toBe(false);
});

test('the dev server: the value is in the head before the early script, and the first paint has the stored model\'s value and the right branch', async () => {
  const root = join(tmp, 'dev');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/sinter.helpers.ts'), HELPERS);
  writeFileSync(join(root, 'index.html'), PAGE);
  const server = await createServer({ root, logLevel: 'silent', resolve: { alias }, server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', plugins: [sinter()] });
  const http = httpServer((req, res) => server.middlewares(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>((ok) => http.listen(0, '127.0.0.1', ok));
  try {
    const html = await server.transformIndexHtml('/index.html', PAGE);
    const value = html.search(/<script type="application\/json" data-sn="\d+">"Hello World"<\/script>/);
    const tag = /<script src="([^"]*\/@sinter\/early\/[^"]*)"><\/script>/.exec(html);
    expect(value, 'the dev page has the build-computed value as an element').toBeGreaterThan(-1);
    expect(tag, 'the dev page has a classic early script').not.toBeNull();
    expect(value, 'the value comes before the early script that reads it').toBeLessThan(tag!.index);
    // the early script as the dev server serves it, run where its tag stands
    const code = await (await fetch(`http://127.0.0.1:${(http.address() as AddressInfo).port}${tag![1]}`)).text();
    expect(code).toContain('$d');
    const inlined = html.replace(tag![0], () => `<script>${code.replace(/<\/script/gi, '<\\/script')}</script>`);
    const fresh = await parsed(inlined, {});
    expect(fresh.errors).toEqual([]);
    expect([!!fresh.document.querySelector('#todo'), !!fresh.document.querySelector('#fine'), !!fresh.document.querySelector('h1')]).toEqual([false, true, false]);
    const stored = await parsed(inlined, { 'sn:pinned': 'true' });
    expect(stored.errors).toEqual([]);
    expect(stored.document.querySelector('h1')?.textContent).toBe('Hello World');
    expect([!!stored.document.querySelector('#todo'), !!stored.document.querySelector('#fine')]).toEqual([false, true]);
  } finally {
    await new Promise((ok) => http.close(ok));
    await server.close();
  }
}, 120000);

test('a value whose text has `$&` or `$1` reaches the first paint as written', async () => {
  // (the plugin puts its tags in with string slices, and with a function where it replaces: no replacement pattern is read)
  const root = join(tmp, 'dollar'), out = join(root, 'dist');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/sinter.helpers.ts'), "export const priced = (s: string): string => s + ' for $& or $\\' and $1';\n");
  writeFileSync(join(root, 'index.html'), PAGE.replace("titled('hello world')", "priced('all')"));
  await build({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter()], build: { outDir: out, emptyOutDir: true, rollupOptions: { input: { index: join(root, 'index.html') } } } });
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  const stored = await firstPaint(out, html, { 'sn:pinned': 'true' });
  expect(stored.errors).toEqual([]);
  expect(stored.document.querySelector('h1')?.textContent).toBe("all for $& or $' and $1");
});

// Where the head scripts go is the compiler's: a comment among the head's own elements (`headMark`), which the plugin
// replaces with them. Before (review round 2 of the branch), the plugin searched the page's text for the first
// stylesheet, module preload or script, and passed over any `<script … data-sn="N">` start tag to stand after the
// values: an embedded resource's data element is such a tag, and the search went on into its JSON text, where an
// article about HTML holds `<script`. The head scripts were written there, the data cut in two.

/** a site of one page, built: its HTML, and its output folder */
async function page(name: string, html: string, options: Parameters<typeof sinter>[0] = {}, more: Plugin[] = [], helpers = HELPERS) {
  const root = join(tmp, name), out = join(root, 'dist');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/sinter.helpers.ts'), helpers);
  writeFileSync(join(root, 'index.html'), html);
  await build({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter(options), ...more], build: { outDir: out, emptyOutDir: true, rollupOptions: { input: { index: join(root, 'index.html') } } } });
  const built = readFileSync(join(out, 'index.html'), 'utf8');
  // (the compiler's comment is gone from every built page)
  expect(built).not.toMatch(/<!--sn-head-/);
  return { out, html: built };
}

/** the text of a post about HTML: what a search of the page's text would take for tags */
const TRICKY = 'Write <script src="/app.js" defer></script> in the head, <link rel="stylesheet" href="/x.css"> for its styles, <!-- a note --> and $& or $1.';
/** a post's JSON as an author writes it in a data element (`</` as `<\/`, which JSON allows, so the element ends where it does) */
const postJson = (body: string) => JSON.stringify({ title: 'Loading a script', body }).replace(/<\//g, '<\\/');
/** a page with the post's data in its head after `before`, a build-computed value the early file reads, and a stored choice */
const POST = (before: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">${before}<title>x</title>
<script type="application/json" data-sn-resource="post">${postJson(TRICKY)}</script></head>
<body data-sn-state="{ pinned: false, title: titled('hello world') }"><sn-resource name="post" src="/api/post" type="any"></sn-resource>
<input id="pin" type="checkbox" data-sn-model="pinned" data-sn-persist="pinned"><button data-sn-on-click="title = title + '!'">t</button>
<h1 data-sn-text="post.title"></h1><p id="body" data-sn-text="post.body"></p><template data-sn-if="pinned"><h2 data-sn-text="title"></h2></template></body></html>
`;

/** where the built head's parts are: the post's data element, the value, the head scripts, the first stylesheet, the page module */
function places(html: string) {
  return {
    data: /<script type="application\/json" data-sn="\d+">(\{[\s\S]*?)<\/script>/.exec(html), value: html.search(/<script type="application\/json" data-sn="\d+">"Hello World"<\/script>/),
    shared: html.search(/<script src="[^"]*sinter-head-[^"]*"><\/script>/), own: html.search(/<script src="[^"]*index-head-[^"]*"><\/script>/),
    css: html.search(/<link rel="stylesheet"/), module: html.search(/<script type="module"/), end: html.indexOf('</head>'),
  };
}

test('embedded data that holds the text `<script`: the data is as written, the head scripts are tags of the head, and the first paint has the post', async () => {
  const { out, html } = await page('data', POST(''));
  const p = places(html);
  expect(p.data, 'the page has its data element').not.toBeNull();
  expect(JSON.parse(p.data![1]!)).toEqual({ title: 'Loading a script', body: TRICKY });
  expect(p.shared).toBeGreaterThan(-1);
  expect(p.shared).toBeLessThan(p.data!.index);
  const painted = await firstPaint(out, html, { 'sn:pinned': 'true' });
  expect(painted.errors).toEqual([]);
  expect(painted.document.querySelector('#body')?.textContent).toBe(TRICKY);
  expect(painted.document.querySelector('h2')?.textContent).toBe('Hello World');
}, 120000);

test.each([
  ['minified, a title first', '', {}],
  ['as written (`minifyHtml: false`), a title first', '', { minifyHtml: false }],
  ['a <style> first', '<style>h1 { color: teal }</style>', {}],
  ['a script of the page\'s own first', '<script>document.documentElement.dataset.theme = "dark";</script>', {}],
  ['a stylesheet of the page\'s own first', '<link rel="stylesheet" href="https://cdn.example/hand.css">', { minifyHtml: false }],
] as const)('%s: the value, then the head scripts, then the stylesheets and the page module; the data as written', async (what, before, options) => {
  const { out, html } = await page(`order-${what.replace(/\W+/g, '-')}`, POST(before), options);
  const p = places(html);
  expect(JSON.parse(p.data![1]!)).toEqual({ title: 'Loading a script', body: TRICKY });
  expect(p.value).toBeGreaterThan(-1);
  expect(p.value, 'the value before the head scripts').toBeLessThan(p.shared);
  expect(p.shared).toBeLessThan(p.own);
  expect(p.own, 'the head scripts before the first stylesheet').toBeLessThan(p.css < 0 ? p.end : p.css);
  expect(p.own, 'and before the page module').toBeLessThan(p.module);
  const painted = await firstPaint(out, html, { 'sn:pinned': 'true' });
  expect(painted.errors).toEqual([]);
  expect(painted.document.querySelector('h2')?.textContent).toBe('Hello World');
  expect(painted.document.querySelector('#body')?.textContent).toBe(TRICKY);
}, 120000);

test('a value whose text holds `</script`, `<!--`, `<link rel="stylesheet"` and `$&`: written escaped, before the head scripts, read as written', async () => {
  const text = TRICKY.replace('$1', '</script><!--');
  const { out, html } = await page('tricky-value', POST(''), {}, [], `export const titled = (s: string): string => ${JSON.stringify(text)} + s;\n`);
  const value = /<script type="application\/json" data-sn="\d+">("Write[^<]*?)<\/script>/.exec(html);
  expect(value).not.toBeNull();
  expect(value!.index).toBeLessThan(places(html).shared);
  const painted = await firstPaint(out, html, { 'sn:pinned': 'true' });
  expect(painted.errors).toEqual([]);
  expect(painted.document.querySelector('h2')?.textContent).toBe(text + 'hello world');
}, 120000);

test('another plugin writes a script first in the head: the values the early script reads still stand before the head scripts', async () => {
  const prepend: Plugin = { name: 'prepend', transformIndexHtml: { order: 'post', handler: () => [{ tag: 'script', children: 'window.__theme = 1;', injectTo: 'head-prepend' }] } };
  const { out, html } = await page('prepend', PAGE, {}, [prepend]);
  const p = places(html);
  expect(html).toContain('window.__theme = 1;');
  expect(p.value).toBeGreaterThan(-1);
  expect(p.value).toBeLessThan(p.shared);
  const stored = await firstPaint(out, html, { 'sn:pinned': 'true' });
  expect(stored.errors).toEqual([]);
  expect(stored.document.querySelector('h1')?.textContent).toBe('Hello World');
}, 120000);

test('a placeholder a server fills (`embed: true`, empty at build): after the head scripts, last in the head, and empty', async () => {
  const { html } = await page('placeholder', `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>x</title></head>
<body><sn-resource name="post" src="/api/post"></sn-resource><h1 data-sn-text="post.title"></h1></body></html>
`, { embed: true });
  const slot = /<script type="application\/json" data-sn="\d+"><\/script>/.exec(html);
  expect(slot, 'the page has its placeholder, empty').not.toBeNull();
  const p = places(html);
  expect(p.shared).toBeGreaterThan(-1);
  expect(p.shared).toBeLessThan(slot!.index);
  expect(slot!.index).toBeLessThan(p.end);
}, 120000);

test('a page with no early file: no head scripts, and nothing left of the compiler\'s comment', async () => {
  const { html } = await page('none', PAGE, { firstPaint: false });
  expect(html).not.toMatch(/<script src="[^"]*-head-/);
  expect(html).toMatch(/<script type="module"/);
}, 120000);

// Nothing sinter writes comes before the head's charset declaration, wherever it stands (review round 3 of the branch):
// a browser looks for it in the page's first 1,024 bytes only, and a page served without a charset in its
// Content-Type is decoded by what it finds there. A stylesheet or a script of the page's own before it keeps the head
// scripts after them; otherwise the values and the head scripts stand where they did.
describe('the charset declaration stays first', () => {
  const at = (html: string, re: RegExp) => html.search(re);
  const charsetAt = (html: string) => at(html, /<meta (charset|http-equiv)=/i);
  test.each([
    ['first', '<meta charset="utf-8"><title>x</title>'],
    ['after the page\'s own stylesheet', '<link rel="stylesheet" href="https://cdn.example/hand.css"><meta charset="utf-8"><title>x</title>'],
    ['after a title and a script of the page\'s own (`http-equiv`)', '<title>x</title><script>window.x = 1;</script><meta http-equiv="Content-Type" content="text/html; charset=utf-8">'],
  ])('%s: the value and the head scripts after it', async (what, head) => {
    const { html } = await page(`charset-${what.replace(/\W+/g, '-')}`, PAGE.replace('<meta charset="utf-8"><title>t</title>', head));
    const p = places(html);
    expect(charsetAt(html)).toBeGreaterThan(-1);
    expect(p.value).toBeGreaterThan(charsetAt(html));
    expect(at(html, /<link rel="preconnect"|<link rel="preload"/) < 0 || at(html, /<link rel="preconnect"|<link rel="preload"/) > charsetAt(html)).toBe(true);
    expect(p.value).toBeLessThan(p.shared);
    expect(p.own).toBeLessThan(p.module);
    // (charset first: as before, the value right after it and the head scripts before the title's stylesheets)
    if (what === 'first') expect(html.slice(charsetAt(html), p.value)).toBe('<meta charset="utf-8">');
  }, 120000);

  test('no charset declaration: the value and the head scripts first in the head', async () => {
    const { html } = await page('charset-none', PAGE.replace('<meta charset="utf-8">', ''));
    const p = places(html);
    expect(charsetAt(html)).toBe(-1);
    expect(p.value).toBe(html.indexOf('<head>') + '<head>'.length);
    expect(p.value).toBeLessThan(p.shared);
    expect(p.own).toBeLessThan(p.module);
  }, 120000);

  test('a long non-ASCII value, the page\'s own stylesheet first: decoded from the bytes, without a charset header, as written', async () => {
    const long = 'é'.repeat(1500);
    const { out, html } = await page('charset-bytes', PAGE.replace('<meta charset="utf-8">', '<link rel="stylesheet" href="https://cdn.example/hand.css"><meta charset="utf-8">'), {}, [], `export const titled = (s: string): string => ${JSON.stringify(long)} + s;\n`);
    const stored = await firstPaint(out, html, { 'sn:pinned': 'true' }, true);
    expect(stored.errors).toEqual([]);
    expect(stored.document.querySelector('h1')?.textContent).toBe(long + 'hello world');
    expect(Buffer.byteLength(html.slice(0, charsetAt(html)))).toBeLessThan(1024);
  }, 120000);
});
