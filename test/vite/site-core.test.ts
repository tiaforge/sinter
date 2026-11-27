// @vitest-environment node
// The site's core (docs/proposals/site-core.md): a build keeps the parts of the core its pages use, their union, and
// compiles the rest away. The parts are read from each page's IR; the built core leaves out the code of the parts no
// page uses, keeps that of the parts one page uses (a page more adds its own), and in Chromium every page still runs.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { compile } from '../../src/compiler/index.js';
import { flagsModule } from '../../src/core-parts.js';
import { chromium } from '../browser.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const root = mkdtempSync(join(tmpdir(), 'sinter-site-core-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const put = (f: string, s: string) => { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), s); };

const parts = (html: string) => compile(`<html><body>${html}</body></html>`, {
  file: '/p/index.html', root: '/p', dev: false, helpers: { module: null, names: [], namespaces: {} }, readFile: () => '', moduleSrc: '/m.js',
}).core;

describe('the parts a page uses, from its IR', () => {
  test('one resource and a text binding: the resource only', () => {
    expect(parts('<sn-resource name="user" src="/api/user"></sn-resource><p data-sn-text="user.name"></p>')).toEqual(['RESOURCE']);
  });
  test('state and a click handler: events, no resource', () => {
    expect(parts('<div data-sn-state="{ n: 0 }"><button data-sn-on-click="n++">+</button><span data-sn-text="n"></span></div>')).toEqual(['EVENTS']);
  });
  test('a list, a branch, a model, a style, an action, a dialog', () => {
    expect(parts(`<sn-resource name="xs" src="/api/xs" key="id"></sn-resource>
<div data-sn-state="{ q: '' }"><input data-sn-model="q">
<template data-sn-for="x in xs"><p data-sn-style="{ color: x.c }" data-sn-text="x.n"></p></template>
<template data-sn-if="q"><b>q</b></template>
<form data-sn-post="/api/xs"><button>send</button></form>
<dialog><span data-sn-text="q"></span></dialog></div>`)).toEqual(['LIST', 'BRANCH', 'ACTION', 'DIALOG', 'EVENTS', 'MODEL', 'STYLE', 'RESOURCE', 'KEYED']);
  });
  test('a page with nothing to run: none', () => {
    expect(parts('<p>hello</p>')).toEqual([]);
  });
  test('the flags module: every part named, those not used off', () => {
    expect(flagsModule(['LIST'])).toContain('export const LIST = true;');
    expect(flagsModule(['LIST'])).toContain('export const DIALOG = false;');
    expect(flagsModule(['LIST'])).toContain('export const SWAP = false;');
    expect(flagsModule(['LIST'], false, true)).toContain('export const SWAP = true;');
  });
});

/** the JavaScript a build wrote, all of it */
const js = (out: string) => readdirSync(join(out, 'assets')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(out, 'assets', f), 'utf8')).join('\n');

describe("a site's core", () => {
  const trimmed = join(root, 'dist'), full = join(root, 'dist-more');
  beforeAll(async () => {
    // a page with state and a handler, and a page with a list from a resource: events, the list and the resource
    put('index.html', `<!doctype html><html><head><title>a</title></head><body>
<div data-sn-state="{ n: 0 }"><button id="inc" data-sn-on-click="n++">+</button><output id="n" data-sn-text="n"></output></div>
</body></html>`);
    put('list.html', `<!doctype html><html><head><title>b</title></head><body>
<sn-resource name="items" src="/items.json" key="id"></sn-resource>
<ul id="items"><template data-sn-for="i in items"><li data-sn-text="i.name"></li></template></ul>
</body></html>`);
    put('public/items.json', JSON.stringify([{ id: 1, name: 'one' }, { id: 2, name: 'two' }]));
    // the same site with a page more: a dialog, an action and a custom element's property
    put('more.html', `<!doctype html><html><head><title>c</title></head><body>
<div data-sn-state="{ n: 0 }"><button data-sn-on-click="n++">+</button><dialog><span data-sn-text="n"></span></dialog>
<form data-sn-post="/api/x"><button>send</button></form><x-y data-sn-with="{ n: 1 }"></x-y></div>
</body></html>`);
    const two = { index: join(root, 'index.html'), list: join(root, 'list.html') };
    const run = (outDir: string, input: Record<string, string>) => build({ root, logLevel: 'silent', plugins: [sinter()], resolve: { alias }, build: { outDir, emptyOutDir: true, rollupOptions: { input } } });
    await run(trimmed, two);
    await run(full, { ...two, more: join(root, 'more.html') });
  }, 120_000);

  test('the parts no page uses are compiled away, those one page uses are kept', () => {
    const a = js(trimmed), b = js(full);
    // dialogs (waits()), actions (aria-busy while sent), props (customElements.whenDefined): with the page that uses them only
    for (const mark of ['dialog:not([open])', 'aria-busy', 'whenDefined']) {
      expect(b, mark).toContain(mark);
      expect(a, mark).not.toContain(mark);
    }
    // the list's early rows and the event delegation: kept
    expect(a).toContain('sinter.early.rows');
    expect(a.length).toBeLessThan(b.length);
  });

  test.skipIf(!chromium)('in Chromium both pages run on the trimmed core', async () => {
    let server: PreviewServer | null = null;
    const browser = await chromium!.launch();
    try {
      server = await preview({ root, logLevel: 'silent', build: { outDir: trimmed }, preview: { port: 0 } });
      const url = server.resolvedUrls!.local[0]!;
      const tab = await browser.newPage();
      const errors: string[] = [];
      tab.on('pageerror', (e) => errors.push(e.message));
      await tab.goto(url);
      await tab.click('#inc');
      await tab.click('#inc');
      await tab.waitForFunction(() => document.querySelector('#n')?.textContent === '2');
      await tab.goto(url + 'list.html');
      await tab.waitForFunction(() => document.querySelector('#items')?.textContent === 'onetwo');
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await new Promise<void>((r) => (server ? server.httpServer.close(() => r()) : r()));
    }
  }, 120_000);
});
