// @vitest-environment node
// Early requests and request middleware in a real browser: a `<link rel="preload" as="fetch">`'s response
// goes to a later fetch of its URL whatever headers that fetch adds (Chromium, any `cache` mode), so a
// token a middleware adds would never be sent. With a config that may change requests the build preloads
// nothing; the early file requests the resource, and its response is handed over only for an unchanged
// request. A benchmark agent's sign-in looped to /login: `/api/me` (a literal `src`) answered 401 from its preload.
import { createServer as http, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { changesRequests } from '../../src/project.js';
import { chromium } from '../browser.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const dir = mkdtempSync(join(tmpdir(), 'sinter-early-mw-'));
const root = join(dir, 'app'), out = join(dir, 'dist');
const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as { port: number }).port)));

beforeAll(async () => {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'index.html'), `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Board</title></head>
<body>
  <sn-resource name="me" src="/api/me" items="user" type="any"></sn-resource>
  <sn-resource name="items" src="/api/items?q={$url.q}" items="items" key="id" type="any"></sn-resource>
  <p id="me" data-sn-text="me ? me.name : ''"></p>
  <ul><template data-sn-for="i in items" data-sn-key="i.id"><li data-sn-text="i.name"></li></template></ul>
</body>
</html>
`);
  writeFileSync(join(root, 'src', 'sinter.config.js'), `import { configure, onUnauthorized } from '@tiaforge-ui/sinter';
const authorize = (req, next) => {
  const token = localStorage.getItem('token');
  if (!token) return next(req);
  const headers = new Headers(req.headers);
  headers.set('Authorization', 'Bearer ' + token);
  return next(new Request(req, { headers }));
};
configure({ request: [authorize, onUnauthorized(() => { document.title = 'signed out'; })] });
`);
  await build({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter()], build: { outDir: out, emptyOutDir: true, minify: false } });
}, 60_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('a config that may change requests: no fetch preload links in the HTML', () => {
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  expect(html).not.toContain('rel="preload" as="fetch"');
});

test('what counts as a config that may change requests', () => {
  expect(changesRequests('configure({ request: [auth] })')).toBe(true);
  expect(changesRequests('const request = [auth]; configure({ request })')).toBe(true);
  expect(changesRequests("configure({ request: [header('X-Key', 'k')] })")).toBe(true);
  expect(changesRequests("import { configure, credentials } from 'x'; configure({ request: [credentials('include')] })")).toBe(true);
  expect(changesRequests('configure({ onError: () => {} }) // request: none')).toBe(false);
  expect(changesRequests('configure({ sessionProbe: "/api/me" })')).toBe(false);
});

test.skipIf(!chromium)('signed in: every resource is requested with the token, and no 401 reaches onUnauthorized', async () => {
  const seen: string[] = [];
  const site = http((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname.startsWith('/api/')) {
      seen.push(`${url.pathname} ${req.headers.authorization ?? '-'}`);
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization !== 'Bearer t') { res.statusCode = 401; return res.end('{}'); }
      return res.end(JSON.stringify(url.pathname === '/api/me' ? { user: { name: 'Ada' } } : { items: [{ id: 1, name: 'one' }] }));
    }
    try {
      const body = readFileSync(join(out, url.pathname === '/' ? 'index.html' : url.pathname));
      res.setHeader('Content-Type', url.pathname.endsWith('.js') ? 'text/javascript' : 'text/html');
      res.end(body);
    } catch { res.statusCode = 404; res.end(); }
  });
  const base = `http://127.0.0.1:${await listen(site)}`;
  const browser = await chromium!.launch();
  try {
    const tab = await browser.newPage();
    await tab.goto(base + '/404');
    await tab.evaluate(() => localStorage.setItem('token', 't'));
    await tab.goto(base + '/');
    await tab.waitForFunction(() => document.querySelector('#me')!.textContent === 'Ada' && document.querySelectorAll('li').length === 1);
    expect(await tab.title()).toBe('Board');
    // the early requests went without the token (401, not handed over); the page's own requests carried it
    expect(seen.filter((s) => s.endsWith('Bearer t')).sort()).toEqual(['/api/items Bearer t', '/api/me Bearer t']);
  } finally {
    await browser.close();
    site.close();
  }
}, 60_000);
