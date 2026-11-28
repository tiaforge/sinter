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
import { build, createServer } from 'vite';
import { afterAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';

// (jsdom ships no types: what this test uses of it)
type Dom = { window: Window & typeof globalThis };
const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string, options: { url: string; runScripts: 'dangerously'; pretendToBeVisual: boolean; beforeParse(window: Dom['window']): void }) => Dom };

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
async function firstPaint(out: string, html: string, stored: Record<string, string>) {
  const inlined = html.replace(/<script src="(\/assets\/[^"]+)"><\/script>/g, (_, src: string) => `<script>${readFileSync(join(out, src), 'utf8').replace(/<\/script/gi, '<\\/script')}</script>`);
  expect(inlined).not.toBe(html);
  return parsed(inlined, stored);
}

/** a page whose classic scripts are written into their tags, parsed by jsdom with the stored values given: the document at DOMContentLoaded */
async function parsed(inlined: string, stored: Record<string, string>) {
  const errors: string[] = [];
  const dom = new JSDOM(inlined, {
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
