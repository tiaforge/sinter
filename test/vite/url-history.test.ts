// @vitest-environment node
// `$url` in a real browser (docs/proposals/url-bindings.md): a search field and a tag bound to the
// URL, an offset list with `page-model`. Typing, paging and filtering push the entries a user
// expects; Back and Forward restore what was shown; a reload and a shared link show the same.
import { createServer as http, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { chromium } from '../browser.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const dir = mkdtempSync(join(tmpdir(), 'sinter-url-history-'));
const root = join(dir, 'app'), out = join(dir, 'dist');
const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port)));

const ALL = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, title: `${i % 3 ? 'go' : 'js'} ${i + 1}`, tag: i % 3 ? 'go' : 'js' }));

beforeAll(async () => {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'index.html'), `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Search</title></head>
<body>
  <sn-resource name="hits" src="/api/hits?q={$url.q}&tag={$url.tag}" items="hits" total="total" key="id"
    paginate="offset" page-size="2" page-model="$url.page" type="any"></sn-resource>
  <input id="q" type="search" data-sn-model="$url.q">
  <select id="tag" data-sn-model="$url.tag"><option value="">all</option><option>go</option><option>js</option></select>
  <ul id="list"><template data-sn-for="h in hits"><li data-sn-text="h.title"></li></template></ul>
  <button id="next" data-sn-on-click="page('hits', 'next')" data-sn-attr="{ disabled: !$meta.hits.hasNext }">next</button>
  <p id="page" data-sn-text="$meta.hits.page"></p>
  <div style="height: 3000px"></div>
  <a id="p2" data-sn-attr="{ href: '?tag=' + ($url.tag ?? '') + '&page=' + 2 }">2</a>
  <a id="p3" data-sn-attr="{ href: '?tag=' + ($url.tag ?? '') + '&page=' + 3 + '#page' }">3</a>
</body>
</html>
`);
  await build({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter()], build: { outDir: out, emptyOutDir: true, minify: false } });
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** the built page and its API */
const serve = () => http((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/api/hits') {
      const q = url.searchParams, page = Number(q.get('page')), n = Number(q.get('limit'));
      const all = ALL.filter((h) => (!q.get('tag') || h.tag === q.get('tag')) && h.title.includes(q.get('q') ?? ''));
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ hits: all.slice((page - 1) * n, page * n), total: all.length }));
    }
    try {
      const body = readFileSync(join(out, url.pathname === '/' ? 'index.html' : url.pathname));
      res.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/html');
      res.end(body);
    } catch { res.statusCode = 404; res.end(); }
});

test.skipIf(!chromium)('type, page, filter, Back, Forward, reload and a shared link', async () => {
  const site = serve();
  const port = await listen(site), base = `http://127.0.0.1:${port}`;
  const browser = await chromium!.launch();
  try {
    const tab = await browser.newPage();
    const shown = () => tab.$$eval('#list li', (li) => li.map((x) => x.textContent).join(','));
    const settled = async (search: string, list: string) => {
      await tab.waitForFunction(([s, l]) => location.search === s && [...document.querySelectorAll('#list li')].map((x) => x.textContent).join(',') === l, [search, list]);
    };
    await tab.goto(base + '/');
    await settled('', 'js 1,go 2');
    // the entries this page added (a new tab starts with about:blank)
    const start = await tab.evaluate(() => history.length);
    const length = async () => (await tab.evaluate(() => history.length)) - start + 1;
    // typing: one entry, once the typing pauses
    await tab.locator('#q').pressSequentially('go', { delay: 30 });
    await settled('?q=go', 'go 2,go 3');
    expect(await length()).toBe(2);
    // paging: an entry per move
    await tab.click('#next');
    await settled('?q=go&page=2', 'go 5,go 6');
    await tab.click('#next');
    await settled('?q=go&page=3', 'go 8,go 9');
    expect(await length()).toBe(4);
    // a filter on page 3: page 1, the page parameter removed, one entry
    await tab.selectOption('#tag', 'go');
    await settled('?q=go&tag=go', 'go 2,go 3');
    expect(await length()).toBe(5);
    // Back: page 3 with the old filter; Back again: page 2; Forward twice: the filter
    await tab.goBack();
    await settled('?q=go&page=3', 'go 8,go 9');
    expect(await tab.inputValue('#tag')).toBe('');
    await tab.goBack();
    await settled('?q=go&page=2', 'go 5,go 6');
    expect(await tab.textContent('#page')).toBe('2');
    await tab.goForward();
    await tab.goForward();
    await settled('?q=go&tag=go', 'go 2,go 3');
    expect(await tab.inputValue('#tag')).toBe('go');
    // Back and Forward wrote nothing
    expect(await length()).toBe(5);
    // reload, and a shared link in a fresh tab: the same state
    await tab.click('#next');
    await settled('?q=go&tag=go&page=2', 'go 5,go 6');
    await tab.reload();
    await settled('?q=go&tag=go&page=2', 'go 5,go 6');
    expect(await tab.inputValue('#q')).toBe('go');
    const other = await browser.newPage();
    await other.goto(base + '/?tag=js&page=2');
    await other.waitForFunction(() => [...document.querySelectorAll('#list li')].map((x) => x.textContent).join(',') === 'js 7');
    expect(await other.inputValue('#tag')).toBe('js');
    // a shared link: the page adds no entry of its own
    const first = await other.evaluate(() => history.length);
    await other.waitForTimeout(400);
    expect(await other.evaluate(() => history.length)).toBe(first);
    expect(await shown()).toBe('go 5,go 6');
  } finally {
    await browser.close();
    site.close();
  }
}, 120_000);

test.skipIf(!chromium)('a pager of links: a plain click stays on the page, Back returns, Ctrl-click opens a new page, a #hash is the browser\'s', async () => {
  const site = serve();
  const port = await listen(site), base = `http://127.0.0.1:${port}`;
  const browser = await chromium!.launch();
  try {
    const context = await browser.newContext(), tab = await context.newPage();
    const shown = () => [...document.querySelectorAll('#list li')].map((x) => x.textContent).join(',');
    await tab.goto(base + '/?tag=go');
    await tab.waitForFunction((f) => new Function('return ' + f)()() === 'go 2,go 3', shown.toString());
    // a mark on the document: a page load would lose it; the pager is at the bottom, scrolled to
    await tab.evaluate(() => { (window as any).same = true; });
    await tab.locator('#p2').scrollIntoViewIfNeeded();
    const scrolled = await tab.evaluate(() => scrollY);
    expect(scrolled).toBeGreaterThan(1000);
    const start = await tab.evaluate(() => history.length);
    await tab.click('#p2');
    await tab.waitForFunction(() => location.search === '?tag=go&page=2' && document.querySelector('#page')!.textContent === '2');
    expect(await tab.evaluate(() => (window as any).same)).toBe(true);
    expect(await tab.evaluate(() => history.length)).toBe(start + 1);
    // the scroll position stays
    expect(await tab.evaluate(() => scrollY)).toBe(scrolled);
    // Back: page 1, still the same document, the scroll position as it was
    await tab.goBack();
    await tab.waitForFunction(() => location.search === '?tag=go' && document.querySelector('#page')!.textContent === '1');
    expect(await tab.evaluate(() => (window as any).same)).toBe(true);
    expect(await tab.evaluate(() => scrollY)).toBe(scrolled);
    // a #hash: the browser's fragment navigation in the new entry (:target)
    await tab.click('#p3');
    await tab.waitForFunction(() => location.search === '?tag=go&page=3' && location.hash === '#page' && document.querySelector('#page')!.textContent === '3');
    expect(await tab.evaluate(() => document.querySelector(':target')?.id)).toBe('page');
    expect(await tab.evaluate(() => (window as any).same)).toBe(true);
    // Ctrl/Cmd-click: left to the browser (not prevented, no entry here), which opens a new page; this one unchanged.
    // The click as it reached the page, after the runtime's listener on the document: a click Playwright lands
    // beside the link (the page still settling from the #hash's scroll) is tried again instead of waiting in vain
    // for a page; one on the link is checked as it was.
    await tab.evaluate(() => addEventListener('click', (e) => {
      (window as any).clicked = { id: (e.target as Element).closest?.('a')?.id ?? null, modified: e.ctrlKey || e.metaKey, prevented: e.defaultPrevented };
    }));
    const entries = await tab.evaluate(() => history.length);
    const opened = context.waitForEvent('page');
    for (let tries = 0; tries < 3; tries++) {
      await tab.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await tab.click('#p2', { modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
      if (await tab.evaluate(() => (window as any).clicked?.id != null)) break;
      await tab.evaluate(() => { delete (window as any).clicked; });
    }
    expect(await tab.evaluate(() => (window as any).clicked)).toEqual({ id: 'p2', modified: true, prevented: false });
    const page = await opened;
    await page.waitForLoadState();
    expect(new URL(page.url()).search).toBe('?tag=go&page=2');
    expect(new URL(tab.url()).search).toBe('?tag=go&page=3');
    expect(await tab.evaluate(() => history.length)).toBe(entries);
    expect(await tab.evaluate(() => (window as any).same)).toBe(true);
  } finally {
    await browser.close();
    site.close();
  }
}, 120_000);
