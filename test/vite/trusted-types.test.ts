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
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
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
  'x-p': '<template data-sn-props="{ node: any }"><p><template data-sn-for="n in node.children"><sn-component use="{ text: \'x-text\', em: \'x-em\', strong: \'x-strong\' }[n.type]" data-sn-with="{ node: n }"></sn-component></template></p></template>',
  'x-em': '<template data-sn-props="{ node: any }"><em><template data-sn-for="n in node.children"><sn-component use="{ text: \'x-text\', em: \'x-em\', strong: \'x-strong\' }[n.type]" data-sn-with="{ node: n }"></sn-component></template></em></template>',
  'x-strong': '<template data-sn-props="{ node: any }"><strong><template data-sn-for="n in node.children"><sn-component use="{ text: \'x-text\', em: \'x-em\', strong: \'x-strong\' }[n.type]" data-sn-with="{ node: n }"></sn-component></template></strong></template>',
  'x-text': '<template data-sn-props="{ node: any }"><span data-sn-text="node.value"></span></template>',
  // section 3: text without an element, and roots that are no element of their own
  'y-p': '<template data-sn-props="{ node: any }"><p><template data-sn-for="n in node.children"><template data-sn-if="n.type === \'text\'"><template data-sn-text="n.value"></template></template><template data-sn-else><y-inline data-sn-with="{ node: n }"></y-inline></template></template></p></template>',
  'y-inline': '<template data-sn-props="{ node: any }"><template data-sn-if="node.type === \'em\'"><em><template data-sn-for="n in node.children"><template data-sn-text="n.value"></template></template></em></template><template data-sn-else><strong><template data-sn-for="n in node.children"><template data-sn-text="n.value"></template></template></strong></template></template>',
  // section 4: a tree root whose link slot is placed deep inside, through shared definitions
  'z-doc': '<template data-sn-props="{ doc?: any; link: Slot<{ node: any }> }"><div class="z"><template data-sn-for="b in doc ? doc.children : []"><z-p data-sn-with="{ node: b }"></z-p></template></div></template>',
  'z-p': '<template data-sn-props="{ node: any }"><p><template data-sn-for="n in node.children"><sn-component use="{ text: \'z-text\', link: \'z-link\', em: \'z-em\' }[n.type]" data-sn-with="{ node: n }"></sn-component></template></p></template>',
  'z-em': '<template data-sn-props="{ node: any }"><em><template data-sn-for="n in node.children"><sn-component use="{ text: \'z-text\', link: \'z-link\', em: \'z-em\' }[n.type]" data-sn-with="{ node: n }"></sn-component></template></em></template>',
  'z-text': '<template data-sn-props="{ node: any }"><span data-sn-text="node.value"></span></template>',
  'z-link': '<template data-sn-props="{ node: any }"><slot name="link" data-sn-with="{ node }"><a data-sn-attr="{ href: node.url }"><template data-sn-for="n in node.children"><sn-component use="{ text: \'z-text\', link: \'z-link\', em: \'z-em\' }[n.type]" data-sn-with="{ node: n }"></sn-component></template></a></slot></template>',
  'ui-button': '<template data-sn-props="{ href?: string; label: string }"><template data-sn-if="href"><a class="btn" data-sn-attr="{ href }" data-sn-text="label"></a></template><template data-sn-else><button class="btn" type="button" data-sn-text="label"></button></template></template>',
};
const LINK_DOC = { children: [
  { type: 'p', children: [{ type: 'text', value: 'a ' }, { type: 'link', url: '/x', children: [{ type: 'text', value: 'x' }] }] },
  { type: 'p', children: [{ type: 'em', children: [{ type: 'em', children: [{ type: 'link', url: '/y', children: [{ type: 'text', value: 'y' }] }] }] }] },
] };
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
  <button id="open" data-sn-on-click="openDialog('d')">open</button>
  <article id="doc"><template data-sn-for="b in doc.children"><sn-component use="{ p: 'x-p' }[b.type]" data-sn-with="{ node: b }"></sn-component></template></article>
</body></html>`);
  writeFileSync(join(root, 'tree.html'), `<!doctype html><html lang="en">${head('Tree')}
<body>
  <sn-resource name="doc" src="/api/doc"></sn-resource>
  <article id="doc"><template data-sn-for="b in doc.children"><sn-component use="{ p: 'x-p' }[b.type]" data-sn-with="{ node: b }"></sn-component></template></article>
</body></html>`);
  writeFileSync(join(root, 'text.html'), `<!doctype html><html lang="en">${head('Text')}
<body data-sn-state="{ items: [{ id: 1, to: '/a' }, { id: 2, to: '' }], n: 0 }">
  <sn-resource name="doc" src="/api/text"></sn-resource>
  <article id="doc"><template data-sn-for="b in doc.children"><y-p data-sn-with="{ node: b }"></y-p></template></article>
  <button id="swap" data-sn-on-click="items = [{ id: 2, to: '/b' }, { id: 1, to: '' }]">swap</button>
  <p id="count">n=<template data-sn-text="n"></template></p>
  <nav id="buttons"><template data-sn-for="it in items" data-sn-key="it.id"><ui-button class="row" data-sn-with="{ href: it.to, label: 'L' + it.id }" data-sn-on-click="$event.preventDefault(); n = n + it.id"></ui-button></template></nav>
</body></html>`);
  writeFileSync(join(root, 'links.html'), `<!doctype html><html lang="en">${head('Links')}
<body data-sn-state="{ rel: 'ugc', clicks: 0 }">
  <sn-resource name="doc" src="/api/links"></sn-resource>
  <p id="clicks" data-sn-text="clicks"></p><button id="rel" data-sn-on-click="rel = 'nofollow'">rel</button>
  <z-doc data-sn-with="{ doc }"><a slot="link" class="mine" data-sn-attr="{ href: $slot.node.url, rel }" data-sn-on-click="$event.preventDefault(); clicks = clicks + 1"><slot></slot>!</a></z-doc>
</body></html>`);
  const input = { index: join(root, 'index.html'), tree: join(root, 'tree.html'), text: join(root, 'text.html'), links: join(root, 'links.html') };
  await build({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter()], build: { outDir: out, emptyOutDir: true, minify: false, rollupOptions: { input } } });
  await build({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter({ embed: true })], build: { outDir: outEmbed, emptyOutDir: true, minify: false, rollupOptions: { input } } });
}, 120_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** a build and its API; `embed`: the page's data slot filled, as a server layer does */
const serve = (from: string, embed = false) => http((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/api/doc') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(DOC)); }
  if (url.pathname === '/api/links') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(LINK_DOC)); }
  if (url.pathname === '/api/text') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(TEXT_DOC)); }
  const path = url.pathname === '/' ? '/index.html' : /^\/[a-z]+\/?$/.test(url.pathname) ? `${url.pathname.replace(/\/$/, '')}/index.html` : url.pathname;
  let body: Buffer | string;
  try { body = readFileSync(join(from, path)); } catch { try { body = readFileSync(join(from, path.replace(/\/index\.html$/, '.html'))); } catch { res.statusCode = 404; return res.end(); } }
  if (embed && path.endsWith('.html')) body = String(body).replace(/(<script type="application\/json" data-sn="\d+">)(<\/script>)/, `$1${JSON.stringify(path.includes('text') ? TEXT_DOC : path.includes('links') ? LINK_DOC : DOC).replace(/</g, '\\u003c')}$2`);
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

/**
 * Opens the page `name` of the build `from` with its page module held back, runs `early` in that state, then lets the
 * module load and mount. With the module not loaded, what is on the page is what the early script rendered: `early`
 * waits for it there and records it. (A `DOMContentLoaded` listener of the test's own, registered before the early
 * script's, ran before the early script's last pass: whether the nodes were there yet depended on how the parser's
 * tasks fell, and now and then a run found none.)
 */
async function open(page: Page, from: string, port: number, name: string, early?: () => Promise<void>): Promise<void> {
  let html: string;
  try { html = readFileSync(join(from, name, 'index.html'), 'utf8'); } catch { html = readFileSync(join(from, `${name}.html`), 'utf8'); }
  const entry = /<script type="module"[^>]*\bsrc="([^"]+)"/.exec(html)![1]!;
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  await page.route((url) => url.pathname === entry, async (route) => { await held; await route.continue(); });
  // (not `load`: it waits for the module)
  await page.goto(`http://127.0.0.1:${port}/${name}/`, { waitUntil: 'domcontentloaded' });
  try { await early?.(); } finally { release(); }
}

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
    // before the page module has loaded: what the early script rendered
    await open(page, outEmbed, port, 'tree', async () => {
      await page.waitForFunction(() => document.querySelectorAll('#doc *').length > 5);
      await page.evaluate(() => { (window as any).__early = [...document.querySelectorAll('#doc *')]; });
    });
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
      // with embedded data the early script renders them: there before the page module has loaded
      await open(page, from, port, 'text', embed ? async () => {
        await page.waitForFunction(() => document.querySelectorAll('#doc p').length === 2);
        await page.evaluate(() => { (window as any).__early = [...document.querySelectorAll('#doc p')].map((p) => [...p.childNodes]); });
      } : undefined);
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

test.skipIf(!chromium)('tree slots under Trusted Types: a link fill at every depth, early over embedded data and at takeover; state it reads', async () => {
  for (const [from, embed] of [[out, false], [outEmbed, true]] as const) {
    const site = serve(from, embed), port = await listen(site), browser = await chromium!.launch();
    try {
      const { page, check } = await tab(browser);
      // with embedded data the early script renders the fills: there before the page module has loaded
      await open(page, from, port, 'links', embed ? async () => {
        await page.waitForFunction(() => document.querySelectorAll('a.mine').length === 2);
        await page.evaluate(() => { (window as any).__early = [...document.querySelectorAll('a.mine')]; });
      } : undefined);
      await page.waitForFunction(() => document.querySelectorAll('a.mine').length === 2);
      await page.waitForLoadState('networkidle');
      const links = () => page.$$eval('a.mine', (a) => a.map((x) => `${x.getAttribute('href')}|${x.getAttribute('rel')}|${x.textContent}`));
      expect(await links()).toEqual(['/x|ugc|x!', '/y|ugc|y!']);
      expect(await page.$$eval('.z p em em a.mine', (a) => a.length)).toBe(1);
      // with embedded data the early script rendered the fills, and the takeover kept them
      if (embed) {
        expect(await page.evaluate(() => (window as any).__early.length)).toBe(2);
        expect(await page.evaluate(() => (window as any).__early.every((a: Element) => a.isConnected))).toBe(true);
      }
      await page.click('#rel');
      await page.waitForFunction(() => document.querySelector('a.mine')!.getAttribute('rel') === 'nofollow');
      expect(await links()).toEqual(['/x|nofollow|x!', '/y|nofollow|y!']);
      await page.click('.z p em em a.mine');
      await page.waitForFunction(() => document.querySelector('#clicks')!.textContent === '1');
      await check();
    } finally { await browser.close(); site.close(); }
  }
}, 90_000);
