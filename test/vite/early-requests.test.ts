// @vitest-environment node
// Early requests in a build: resources on an origin listed in `sinter({ origins })` are preloaded or
// requested before the page module like same-origin ones, `early="off"` keeps one out, and a page
// with early requests loads its early file `async` before the stylesheets (the requests leave while
// they load) and renders it from a render-blocking stub.
import { createServer as http, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { chromium } from '../browser.js';

const src = resolve(__dirname, '../../src');
const alias = ['sse', 'optimistic', 'paginate', 'persist', 'early', 'prefetch', 'transition', 'cache', 'apply', 'form', 'select', 'location', 'call', 'debounce', 'confirm', 'models']
  .map((f) => ({ find: `@tiaforge-ui/sinter/${f}`, replacement: `${src}/${f}.ts` }))
  .concat([{ find: '@tiaforge-ui/sinter', replacement: `${src}/index.ts` }]);

const dir = mkdtempSync(join(tmpdir(), 'sinter-early-req-'));
const root = join(dir, 'app'), out = join(dir, 'dist');
const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port)));

// the API, on its own origin: every request logged with the time it arrived
const log: Array<{ path: string; at: number }> = [];
const api = http((req, res) => {
  log.push({ path: req.url!, at: Date.now() });
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.url!.startsWith('/items')) return res.end(JSON.stringify({ items: [{ id: 1, name: 'from the api' }] }));
  if (req.url!.startsWith('/pages')) return res.end(JSON.stringify({ items: [{ id: 1 }, { id: 2 }], total: 3 }));
  if (req.url === '/tags') return res.end(JSON.stringify({ tags: ['a'] }));
  if (req.url === '/me') return res.end(JSON.stringify({ me: { name: 'me' } }));
  res.statusCode = 404; res.end('{}');
});
let apiOrigin = '';
const logs: string[] = [];

beforeAll(async () => {
  apiOrigin = `http://127.0.0.1:${await listen(api)}`;
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'index.html'), `<!doctype html>
<html data-sn-path="/">
<head><meta charset="utf-8"><title>early</title><link rel="stylesheet" href="/slow.css"></head>
<body>
  <sn-resource name="items" src="${apiOrigin}/items?q={$url.q}" items="items" key="id" type="any"></sn-resource>
  <sn-resource name="tags" src="${apiOrigin}/tags" items="tags" type="any"></sn-resource>
  <sn-resource name="pages" src="${apiOrigin}/pages?q={$url.q}" items="items" total="total" key="id" type="any" paginate="keyset" page-size="2" cursor="{after: id}" direction-values="{first: 'down'}"></sn-resource>
  <sn-resource name="me" src="${apiOrigin}/me" items="me" type="any" early="off"></sn-resource>
  <sn-resource name="other" src="https://other.example/x" type="any" when="false"></sn-resource>
  <ul><template data-sn-for="i in items"><li data-sn-text="i.name"></li></template></ul>
  <p id="tags" data-sn-text="tags ? tags.length : ''"></p>
  <p id="pages" data-sn-text="[pages.length, $meta.pages.total, $meta.pages.hasNext].join()"></p>
  <p id="me" data-sn-text="me ? me.name : ''"></p>
  <p id="other" data-sn-text="other ? 'x' : ''"></p>
</body>
</html>
`);
  // no configure({ origins }): the build's list is the runtime's too (the browser test's `me` request needs it)
  writeFileSync(join(root, 'src', 'sinter.config.js'), `import { configure } from '@tiaforge-ui/sinter';\nconfigure({ onError: () => {} });\n`);
  await build({
    root, resolve: { alias }, build: { outDir: out, emptyOutDir: true, minify: false },
    customLogger: { info: (m: string) => { logs.push(m); }, warn: (m: string) => { logs.push(m); }, warnOnce: () => {}, error: () => {}, clearScreen: () => {}, hasErrorLogged: () => false, hasWarned: false } as never,
    plugins: [sinter({ origins: [apiOrigin] })],
  });
}, 60_000);
afterAll(() => { api.close(); rmSync(dir, { recursive: true, force: true }); });

test('a listed origin is preloaded and requested early; early="off" and an unlisted origin are not', () => {
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  expect(html).toContain(`<link rel="preload" as="fetch" crossorigin="" href="${apiOrigin}/tags">`);
  expect(html).not.toContain(`href="${apiOrigin}/me"`);
  expect(html).not.toContain('other.example/x"');
  const early = /<script src="\/assets\/(index-head-[\w-]+\.js)"><\/script>/.exec(html)![1]!;
  const code = readFileSync(join(out, 'assets', early), 'utf8');
  expect(code).toContain(`${apiOrigin}/items?q=`);
  // a paginated resource: its first page
  expect(code).toContain(`${apiOrigin}/pages?q=`);
  expect(code).toMatch(/"q": \{\s*"limit": "2",\s*"direction": "down"\s*\}/);
  expect(code).not.toContain('other.example');
  // the build names the origin it could have requested early
  expect(logs.find((l) => l.includes('https://other.example'))).toMatch(/requested when the page module runs; list the origin in sinter\(\{ origins/);
  // the page module adds the build's origins to the runtime's allowlist, after the app's config module
  const page = /src="\/assets\/(index-[\w-]+\.js)" async>/.exec(html)![1]!;
  expect(readFileSync(join(out, 'assets', page), 'utf8')).toContain(`$origins(["${apiOrigin}"])`);
});

test('a page with early requests: the shared and the page\'s head script, classic, first in the head, before the stylesheets; nothing render-blocking', () => {
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  const shared = /<script src="\/assets\/(sinter-head-[\w-]+\.js)"><\/script>/.exec(html)!;
  const own = /<script src="\/assets\/(index-head-[\w-]+\.js)"><\/script>/.exec(html)!;
  expect(shared).not.toBeNull();
  expect(own).not.toBeNull();
  expect(html.indexOf(shared[0])).toBeLessThan(html.indexOf(own[0]));
  expect(html.indexOf(own[0])).toBeLessThan(html.indexOf('<link rel="stylesheet"'));
  expect(html).not.toContain('blocking=');
  // the runtime is in the shared script once; the page's takes it from the global the shared one sets
  const sharedCode = readFileSync(join(out, 'assets', shared[1]!), 'utf8'), ownCode = readFileSync(join(out, 'assets', own[1]!), 'utf8');
  expect(sharedCode).toContain('MutationObserver');
  expect(ownCode).not.toContain('MutationObserver');
  for (const code of [sharedCode, ownCode]) expect(code).toContain('Symbol.for("sinter.early.rt")');
  for (const code of [sharedCode, ownCode]) expect(code).not.toMatch(/^\s*(import|export)\b/m);
});

test.runIf(!!chromium)('in Chromium: the requests leave while a slow stylesheet loads (a paginated resource\'s first page too), once each, and the page renders their data', async () => {
  let cssDone = 0;
  const site = http((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (path === '/slow.css') {
      setTimeout(() => { res.setHeader('Content-Type', 'text/css'); res.end('body { color: black }'); cssDone = Date.now(); }, 800);
      return;
    }
    try {
      const body = readFileSync(join(out, path === '/' ? 'index.html' : path));
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/html');
      res.end(body);
    } catch { res.statusCode = 404; res.end(); }
  });
  const port = await listen(site);
  const browser = await chromium!.launch();
  try {
    log.length = 0;
    const tab = await browser.newPage();
    const errors: string[] = [];
    tab.on('pageerror', (e) => errors.push(e.message));
    tab.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await tab.goto(`http://127.0.0.1:${port}/?q=x`);
    await tab.waitForFunction(() => document.querySelector('li')?.textContent === 'from the api' && document.querySelector('#me')!.textContent === 'me');
    const items = log.filter((l) => l.path.startsWith('/items'));
    expect(items.map((l) => l.path)).toEqual(['/items?q=x']);   // once: the runtime took the early response
    expect(items[0]!.at).toBeLessThan(cssDone);                  // before the stylesheet had arrived
    expect(log.filter((l) => l.path === '/tags')).toHaveLength(1);
    // the first page of a paginated resource, early and once
    const pages = log.filter((l) => l.path.startsWith('/pages'));
    expect(pages.map((l) => l.path)).toEqual(['/pages?q=x&limit=2&direction=down']);
    expect(pages[0]!.at).toBeLessThan(cssDone);
    await tab.waitForFunction(() => document.querySelector('#pages')!.textContent === '2,3,true');
    expect(log.filter((l) => l.path === '/me')).toHaveLength(1);   // early="off": only the page module's request
    expect(await tab.textContent('#tags')).toBe('1');
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    site.close();
  }
}, 60_000);

test('`early` takes only `off`', async () => {
  const { checkPage } = await import('../../src/check/index.js');
  const page = (v: string) => `<sn-resource name="a" src="/api/a" type="any" early="${v}"></sn-resource><p data-sn-text="a"></p>`;
  expect(checkPage(page('off')).filter((d) => d.severity === 'error')).toEqual([]);
  expect(checkPage(page('no'))).toEqual([expect.objectContaining({ code: 'SN401', message: '`early` takes only `off`' })]);
});
