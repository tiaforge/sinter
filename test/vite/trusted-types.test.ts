// @vitest-environment node
// The browser harness that enforces Trusted Types (docs/proposals/component-libraries.md, Testing): built pages
// under `script-src 'self'; style-src 'self'; require-trusted-types-for 'script'`, in Chromium, failing on any
// violation report or console error. On it, anchors as comments (section 1): lists and keyed reorders, branches,
// choices and trees, rows that render nothing, tables, `<select>`, SVG, dialogs, and the first paint over embedded
// data with the page module's takeover.
import { createServer as http, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { Page } from 'playwright';
import sinter from '../../src/vite.js';
import { chromium } from '../browser.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const dir = mkdtempSync(join(tmpdir(), 'sinter-trusted-types-'));
const root = join(dir, 'app'), out = join(dir, 'dist'), outEmbed = join(dir, 'dist-embed');
const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port)));

/** the policy every page of the harness runs under */
export const CSP = "script-src 'self'; style-src 'self'; require-trusted-types-for 'script'";
const head = (title: string) => `<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"><title>${title}</title><link rel="stylesheet" href="/style.css"></head>`;

const DOC = { children: [
  { type: 'p', children: [{ type: 'text', value: 'a ' }, { type: 'em', children: [{ type: 'strong', children: [{ type: 'text', value: 'b' }] }] }] },
  { type: 'p', children: [{ type: 'text', value: 'c &amp; d' }] },
] };
const COMPONENTS: Record<string, string> = {
  'x-p': '<template data-sn-component="{ node: any }"><p><template data-sn-for="n in node.children"><sn-component use="{ text: \'x-text\', em: \'x-em\', strong: \'x-strong\' }[n.type]" data-sn-prop="{ node: n }"></sn-component></template></p></template>',
  'x-em': '<template data-sn-component="{ node: any }"><em><template data-sn-for="n in node.children"><sn-component use="{ text: \'x-text\', em: \'x-em\', strong: \'x-strong\' }[n.type]" data-sn-prop="{ node: n }"></sn-component></template></em></template>',
  'x-strong': '<template data-sn-component="{ node: any }"><strong><template data-sn-for="n in node.children"><sn-component use="{ text: \'x-text\', em: \'x-em\', strong: \'x-strong\' }[n.type]" data-sn-prop="{ node: n }"></sn-component></template></strong></template>',
  'x-text': '<template data-sn-component="{ node: any }"><span data-sn-text="node.value"></span></template>',
  // section 3: text without an element, and roots that are no element of their own
  'y-p': '<template data-sn-component="{ node: any }"><p><template data-sn-for="n in node.children"><template data-sn-if="n.type === \'text\'"><template data-sn-text="n.value"></template></template><template data-sn-else><y-inline data-sn-prop="{ node: n }"></y-inline></template></template></p></template>',
  'y-inline': '<template data-sn-component="{ node: any }"><template data-sn-if="node.type === \'em\'"><em><template data-sn-for="n in node.children"><template data-sn-text="n.value"></template></template></em></template><template data-sn-else><strong><template data-sn-for="n in node.children"><template data-sn-text="n.value"></template></template></strong></template></template>',
  'ui-button': '<template data-sn-component="{ href?: string; label: string }"><template data-sn-if="href"><a class="btn" data-sn-attr="{ href }" data-sn-text="label"></a></template><template data-sn-else><button class="btn" type="button" data-sn-text="label"></button></template></template>',
};
const TEXT_DOC = { children: [
  { type: 'p', children: [{ type: 'text', value: 'a ' }, { type: 'em', children: [{ type: 'text', value: 'b' }] }, { type: 'text', value: ' c' }] },
  { type: 'p', children: [{ type: 'strong', children: [{ type: 'text', value: 'd' }] }, { type: 'text', value: '' }, { type: 'text', value: 'e' }, { type: 'text', value: 'f' }] },
] };

beforeAll(async () => {
  mkdirSync(join(root, 'src/components'), { recursive: true });
  for (const [n, c] of Object.entries(COMPONENTS)) writeFileSync(join(root, 'src/components', `${n}.html`), c);
  mkdirSync(join(root, 'public'), { recursive: true });
  // prose CSS over lists: the rules the old anchors broke
  writeFileSync(join(root, 'public/style.css'), 'li:first-child { color: rgb(255, 0, 0) } li + li { margin-top: 3px } h2 + p { color: rgb(0, 0, 255) } tr:nth-child(even) { color: rgb(0, 128, 0) }');
  writeFileSync(join(root, 'index.html'), `<!doctype html><html lang="en">${head('Anchors')}
<body data-sn-state="{ xs: [1, 2, 3], on: true, rs: [1, 2, 3, 4], os: ['x', 'y'], sel: 'y', ps: [1, 2], doc: ${JSON.stringify(DOC).replace(/"/g, "'")} }">
  <button id="rev" data-sn-on-click="xs = [...xs].reverse()">rev</button>
  <button id="add" data-sn-on-click="xs = [0, ...xs, xs.length + 1]">add</button>
  <button id="clear" data-sn-on-click="xs = []">clear</button>
  <button id="flip" data-sn-on-click="on = !on">flip</button>
  <button id="swap" data-sn-on-click="doc = { children: [{ type: 'p', children: [{ type: 'strong', children: [{ type: 'text', value: 'z' }] }] }] }; rs = rs; os = os; ps = ps; sel = sel">swap</button>
  <ul id="list"><template data-sn-for="x in xs" data-sn-key="x"><li data-sn-text="x"></li></template></ul>
  <section id="branch"><template data-sn-if="on"><h2>on</h2><p>after the heading</p></template><template data-sn-else><i>off</i></template></section>
  <ol id="empty-rows"><template data-sn-for="x in xs" data-sn-key="x"><template data-sn-if="!on"><li data-sn-text="x"></li></template></template></ol>
  <table><tbody id="rows"><template data-sn-for="r in rs" data-sn-key="r"><tr><td data-sn-text="r"></td></tr></template></tbody></table>
  <select id="pick" data-sn-model="sel"><template data-sn-for="o in os" data-sn-key="o"><option data-sn-attr="{ value: o }" data-sn-text="o"></option></template></select>
  <svg id="chart" viewBox="0 0 10 10"><template data-sn-for="p in ps" data-sn-key="p"><circle r="1" data-sn-attr="{ cx: p }"></circle></template></svg>
  <dialog id="d"><ul id="in-dialog"><template data-sn-for="x in xs" data-sn-key="x"><li data-sn-text="x"></li></template></ul></dialog>
  <button id="open" data-sn-on-click="showModal('d')">open</button>
  <article id="doc"><template data-sn-for="b in doc.children"><sn-component use="{ p: 'x-p' }[b.type]" data-sn-prop="{ node: b }"></sn-component></template></article>
</body></html>`);
  writeFileSync(join(root, 'tree.html'), `<!doctype html><html lang="en">${head('Tree')}
<body>
  <sn-resource name="doc" src="/api/doc"></sn-resource>
  <article id="doc"><template data-sn-for="b in doc.children"><sn-component use="{ p: 'x-p' }[b.type]" data-sn-prop="{ node: b }"></sn-component></template></article>
</body></html>`);
  writeFileSync(join(root, 'text.html'), `<!doctype html><html lang="en">${head('Text')}
<body data-sn-state="{ items: [{ id: 1, to: '/a' }, { id: 2, to: '' }], n: 0 }">
  <sn-resource name="doc" src="/api/text"></sn-resource>
  <article id="doc"><template data-sn-for="b in doc.children"><y-p data-sn-prop="{ node: b }"></y-p></template></article>
  <button id="swap" data-sn-on-click="items = [{ id: 2, to: '/b' }, { id: 1, to: '' }]">swap</button>
  <p id="count">n=<template data-sn-text="n"></template></p>
  <nav id="buttons"><template data-sn-for="it in items" data-sn-key="it.id"><ui-button class="row" data-sn-prop="{ href: it.to, label: 'L' + it.id }" data-sn-on-click="$event.preventDefault(); n = n + it.id"></ui-button></template></nav>
</body></html>`);
  const input = { index: join(root, 'index.html'), tree: join(root, 'tree.html'), text: join(root, 'text.html') };
  await build({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter()], build: { outDir: out, emptyOutDir: true, minify: false, rollupOptions: { input } } });
  await build({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter({ embed: true })], build: { outDir: outEmbed, emptyOutDir: true, minify: false, rollupOptions: { input } } });
}, 120_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** a build and its API; `embed`: the page's data slot filled, as a server layer does */
const serve = (from: string, embed = false) => http((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/api/doc') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(DOC)); }
  if (url.pathname === '/api/text') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(TEXT_DOC)); }
  const path = url.pathname === '/' ? '/index.html' : /^\/[a-z]+\/?$/.test(url.pathname) ? `${url.pathname.replace(/\/$/, '')}/index.html` : url.pathname;
  let body: Buffer | string;
  try { body = readFileSync(join(from, path)); } catch { try { body = readFileSync(join(from, path.replace(/\/index\.html$/, '.html'))); } catch { res.statusCode = 404; return res.end(); } }
  if (embed && path.endsWith('.html')) body = String(body).replace(/(<script type="application\/json" data-sn="\d+">)(<\/script>)/, `$1${JSON.stringify(path.includes('text') ? TEXT_DOC : DOC).replace(/</g, '\\u003c')}$2`);
  res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(body);
});

test('the build: head templates are last in the head, after every stylesheet, preload and script; the rest at the end of the body', () => {
  for (const d of [out, outEmbed]) {
    const html = readFileSync(join(d, 'tree/index.html'), 'utf8'), head = html.slice(0, html.indexOf('</head>'));
    const lastFetch = Math.max(...[...head.matchAll(/<link\b[^>]*\brel="(?:stylesheet|modulepreload|preload)"|<script\b/g)].map((m) => m.index!));
    const firstTemplate = head.search(/<template id="sn-t-/);
    if (firstTemplate >= 0) expect(firstTemplate, d).toBeGreaterThan(lastFetch);
    // without embedded data the early file renders no list: every template at the end of the body; with it, in the head
    if (d === out) { expect(firstTemplate).toBe(-1); expect(html).toMatch(/<template id="sn-t-\d+"[^>]*>[\s\S]*<\/template>\s*<\/body>/); }
    else expect(firstTemplate).toBeGreaterThan(0);
  }
});

/** a tab that records every policy violation and console error; `check()` fails the test on any */
async function tab(browser: Awaited<ReturnType<NonNullable<typeof chromium>['launch']>>): Promise<{ page: Page; check: () => Promise<void> }> {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    (window as any).__violations = [];
    document.addEventListener('securitypolicyviolation', (e) => (window as any).__violations.push(`${e.violatedDirective} ${e.sample}`));
  });
  return { page, check: async () => {
    expect(await page.evaluate(() => (window as any).__violations)).toEqual([]);
    expect(errors).toEqual([]);
  } };
}
const shape = (page: Page, sel: string) => page.$eval(sel, (el) => [...el.childNodes].map((n) => (n.nodeType === 8 ? `<!--${(n as Comment).data}-->` : n.nodeType === 1 ? (n as Element).localName : null)).filter(Boolean));

test.skipIf(!chromium)('lists, branches, choices, tables, options, SVG and dialogs under Trusted Types', async () => {
  const site = serve(out), port = await listen(site), browser = await chromium!.launch();
  try {
    const { page, check } = await tab(browser);
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector('#list li');
    const texts = (sel: string) => page.$$eval(sel, (els) => els.map((e) => e.textContent));
    // the list: rows between the anchor's comments, CSS sees them as plain children
    expect((await shape(page, '#list')).slice(1)).toEqual(['li', 'li', 'li', '<!--/sn-->']);
    expect(await page.$eval('#list li', (li) => getComputedStyle(li).color)).toBe('rgb(255, 0, 0)');
    expect(await page.$eval('#list li', (li) => getComputedStyle(li).marginTop)).toBe('0px');
    // keyed reorders keep the nodes
    await page.evaluate(() => { (window as any).__first = document.querySelector('#list li'); });
    await page.click('#rev');
    await page.waitForFunction(() => document.querySelector('#list li')!.textContent === '3');
    expect(await page.evaluate(() => document.querySelector('#list li:last-child') === (window as any).__first)).toBe(true);
    await page.click('#add');
    await page.waitForFunction(() => document.querySelectorAll('#list li').length === 5);
    expect(await texts('#list li')).toEqual(['0', '3', '2', '1', '4']);
    expect(await page.$eval('#list li', (li) => getComputedStyle(li).color)).toBe('rgb(255, 0, 0)');
    // the branch: `h2 + p` matches inside it; the else replaces it
    expect(await page.$eval('#branch p', (p) => getComputedStyle(p).color)).toBe('rgb(0, 0, 255)');
    await page.click('#flip');
    await page.waitForSelector('#branch i');
    expect((await shape(page, '#branch')).slice(1)).toEqual(['i', '<!--/sn-->']);
    // rows whose content rendered nothing, then their branch
    expect(await texts('#empty-rows li')).toEqual(['0', '3', '2', '1', '4']);
    // table rows: parsed as rows (the head template is parsed as template content), parity as in plain HTML
    expect(await page.$$eval('#rows tr', (trs) => trs.map((tr) => getComputedStyle(tr).color))).toEqual(['rgb(0, 0, 0)', 'rgb(0, 128, 0)', 'rgb(0, 0, 0)', 'rgb(0, 128, 0)']);
    expect(await page.$eval('#pick', (s) => [(s as HTMLSelectElement).value, (s as HTMLSelectElement).options.length])).toEqual(['y', 2]);
    expect(await page.$$eval('#chart circle', (cs) => cs.map((c) => [c.namespaceURI, c.getAttribute('cx')]))).toEqual([['http://www.w3.org/2000/svg', '1'], ['http://www.w3.org/2000/svg', '2']]);
    // a list in a closed dialog renders when it opens
    expect(await page.$$eval('#in-dialog li', (l) => l.length)).toBe(0);
    await page.click('#open');
    await page.waitForFunction(() => document.querySelectorAll('#in-dialog li').length === 5);
    // a tree through choices (its data in a `data-sn-state` attribute: the parser decodes `&amp;` there)
    expect(await page.$eval('#doc', (a) => a.textContent)).toBe('a bc & d');
    expect(await page.$$eval('#doc p em strong span', (s) => s.length)).toBe(1);
    expect(await page.$$eval('#doc template', (t) => t.length)).toBe(0);
    await page.evaluate(() => (document.querySelector('#d') as HTMLDialogElement).close());
    await page.click('#swap');
    await page.waitForFunction(() => document.querySelector('#doc')!.textContent === 'z');
    expect(await page.$$eval('#doc p > strong > span', (s) => s.length)).toBe(1);
    await page.click('#clear');
    await page.waitForFunction(() => !document.querySelector('#list li'));
    expect(await page.$eval('#list', (ul) => ul.matches(':empty'))).toBe(true);
    await check();
  } finally { await browser.close(); site.close(); }
}, 60_000);

test.skipIf(!chromium)('a tree over embedded data: rendered by the early script through choices, adopted by the page module', async () => {
  const site = serve(outEmbed, true), port = await listen(site), browser = await chromium!.launch();
  try {
    const { page, check } = await tab(browser);
    // before the page module runs: what the early script rendered
    await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
      (window as any).__early = [...document.querySelectorAll('#doc *')];
    }));
    await page.goto(`http://127.0.0.1:${port}/tree/`);
    await page.waitForFunction(() => (window as any).__early !== undefined);
    await page.waitForLoadState('networkidle');
    expect(await page.evaluate(() => (window as any).__early.length)).toBeGreaterThan(5);
    expect(await page.$eval('#doc', (a) => a.textContent)).toBe('a bc &amp; d');
    // the same nodes after the takeover: nothing cloned again
    expect(await page.evaluate(() => (window as any).__early.every((e: Element) => e.isConnected))).toBe(true);
    expect(await page.$$eval('#doc *', (els) => els.length)).toBe(await page.evaluate(() => (window as any).__early.length));
    await check();
  } finally { await browser.close(); site.close(); }
}, 60_000);

test.skipIf(!chromium)('text without an element and roots that are no element, under Trusted Types: early, at takeover, and replaced in a keyed list', async () => {
  for (const [from, embed] of [[out, false], [outEmbed, true]] as const) {
    const site = serve(from, embed), port = await listen(site), browser = await chromium!.launch();
    try {
      const { page, check } = await tab(browser);
      await page.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
        (window as any).__early = [...document.querySelectorAll('#doc p')].map((p) => [...p.childNodes]);
      }));
      await page.goto(`http://127.0.0.1:${port}/text/`);
      await page.waitForFunction(() => document.querySelectorAll('#doc p').length === 2);
      await page.waitForLoadState('networkidle');
      // runs of text beside elements, side by side and empty: one node each, no wrapper
      expect(await page.$$eval('#doc p', (ps) => ps.map((p) => p.textContent))).toEqual(['a b c', 'def']);
      expect(await page.$$eval('#doc span', (s) => s.length)).toBe(0);
      expect(await page.$eval('#doc p', (p) => [...p.childNodes].filter((n) => n.nodeType === 3).map((n) => (n as Text).data))).toEqual(['a ', ' c']);
      // an if root: the inline element itself, no wrapper
      expect(await page.$$eval('#doc p > em, #doc p > strong', (e) => e.map((x) => x.localName))).toEqual(['em', 'strong']);
      // with embedded data the early script rendered them, and the takeover kept every node
      if (embed) expect(await page.evaluate(() => (window as any).__early.flat().every((n: Node) => n.isConnected))).toBe(true);
      // a root per row, replaced on its own when its condition changes, with the tag's class and handler
      const rows = () => page.$$eval('#buttons .row', (e) => e.map((x) => `${x.localName}:${x.textContent}`));
      expect(await rows()).toEqual(['a:L1', 'button:L2']);
      await page.click('#swap');
      await page.waitForFunction(() => document.querySelector('#buttons .row')!.textContent === 'L2');
      expect(await rows()).toEqual(['a:L2', 'button:L1']);
      await page.click('#buttons button.row');
      await page.click('#buttons a.row');
      await page.waitForFunction(() => document.querySelector('#count')!.textContent === 'n=3');
      await check();
    } finally { await browser.close(); site.close(); }
  }
}, 90_000);
