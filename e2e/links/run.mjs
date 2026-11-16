// Same-page links and navigate() through the navigation chain, in Chromium, Firefox and WebKit (Playwright;
// a browser that is not installed is reported as skipped). Where the browser has the Navigation API, its
// `navigate` event is the one source of intents and a same-page link intercepts it; the checks are the
// same as for the click path the unit tests cover. Exits non-zero on any failure.
//   node run.mjs [chromium|firefox|webkit ...]
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = fileURLToPath(new URL('.', import.meta.url));
const pw = createRequire(join(here, '../../package.json'))('playwright');
if (spawnSync('npx', ['vite', 'build', '--logLevel', 'warn'], { cwd: here, stdio: 'inherit' }).status) process.exit(1);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const file = path === '/' ? 'index.html' : path === '/other/' ? 'other/index.html' : normalize(path).replace(/^\/+/, '');
  try {
    const body = await readFile(join(here, 'dist', file));
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Not found</title>'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let failed = 0;
const browsers = process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'firefox', 'webkit'];
for (const name of browsers) {
  let browser;
  // a browser that does not start: skipped here, a failure in CI (where all three are installed)
  try { browser = await pw[name].launch(); } catch (e) {
    console.log(`${name}: ${process.env.CI ? '✗ did not start' : 'skipped'} (${e.message.split('\n')[0]})`);
    if (process.env.CI) failed++;
    continue;
  }
  const page = await browser.newPage();
  const errors = [], loads = [], steps = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => { if (r.isNavigationRequest() && r.frame() === page.mainFrame()) loads.push(new URL(r.url()).pathname + new URL(r.url()).search); });
  const check = (step, got, want) => {
    const bad = Object.entries(want).filter(([k, v]) => JSON.stringify(got[k]) !== JSON.stringify(v));
    steps.push(bad.length ? `✗ ${step}: ${bad.map(([k, v]) => `${k} ${JSON.stringify(got[k])}, want ${JSON.stringify(v)}`).join('; ')}` : `✓ ${step}`);
    if (bad.length) failed++;
  };
  const read = () => page.evaluate(() => ({ url: location.pathname + location.search + location.hash, page: document.getElementById('page')?.textContent, q: document.getElementById('q')?.textContent, entries: history.length, marker: window.__marker ?? null, api: typeof navigation != 'undefined' }));
  const click = (id) => page.evaluate((i) => document.getElementById(i).click(), id);
  const until = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 5000 }).catch(() => {});
  try {
    await page.goto(base + '/');
    await until(() => document.getElementById('page')?.textContent === '1');
    await page.evaluate(() => { window.__marker = 1; });
    const n0 = (await read()).entries;
    steps.push(`- the Navigation API: ${(await read()).api ? 'yes, the navigate event is the source' : 'no, the click listener is'}`);

    await click('p2');
    await until(() => document.getElementById('page').textContent === '2');
    check('a same-page link: in the page, a new entry', await read(), { url: '/?page=2', page: '2', entries: n0 + 1, marker: 1 });

    await page.goBack();
    await until(() => document.getElementById('page').textContent === '1');
    check('Back: $url read again', await read(), { url: '/', page: '1', marker: 1 });
    await page.goForward();
    await until(() => document.getElementById('page').textContent === '2');
    check('Forward', await read(), { url: '/?page=2', page: '2', marker: 1 });

    await click('go4');
    await until(() => document.getElementById('page').textContent === '4');
    check('navigate() in a handler: in the page', await read(), { url: '/?page=4', page: '4', marker: 1 });

    await click('p3');
    await until(() => document.getElementById('page').textContent === '3');
    const n3 = (await read()).entries;
    await click('p3again');
    await page.waitForTimeout(200);
    check('a link to the URL shown: nothing changes', await read(), { url: '/?page=3', page: '3', entries: n3, marker: 1 });

    await click('hash');
    await until(() => location.hash === '#bottom');
    await page.waitForTimeout(150);
    const seen = await page.evaluate(() => document.getElementById('bottom').getBoundingClientRect().top < innerHeight);
    check('the same query with a #hash: the browser scrolls to it', { ...(await read()), seen }, { url: '/?page=3#bottom', marker: 1, seen: true });

    // typing waits for its pause; a link clicked before it: the typed query in its own entry, then the link's
    await page.evaluate(() => scrollTo(0, 0));
    const nt = (await read()).entries;
    await page.fill('#search', 'abc');
    await click('p2');
    await until(() => document.getElementById('page').textContent === '2');
    await page.waitForTimeout(300);
    // the link shows what loading its URL would show (no `q`); the typed query is its own entry, one Back away
    check('typing, then a link before its pause: the link\'s URL, a new entry for each', await read(), { url: '/?page=2', page: '2', q: '-', marker: 1, entries: nt + 2 });
    await page.goBack();
    await until(() => document.getElementById('q').textContent === 'abc');
    check('and Back: the typed query', await read(), { q: 'abc', marker: 1 });
    await page.goForward();
    await until(() => document.getElementById('page').textContent === '2');

    // the guard: while dirty, a same-page link, navigate() and Back are refused; resting on a link (next-page
    // data asks the chain) runs no guard; once clean, they go
    await page.evaluate(() => scrollTo(0, 0));
    const guarded = () => page.evaluate(() => +document.getElementById('seen').textContent);
    const before = await guarded();
    await page.hover('#p3');
    await page.waitForTimeout(200);
    const s0 = await guarded();
    check('resting on a link runs no guard', { runs: s0 - before }, { runs: 0 });
    await click('dirty');
    const g0 = await read();
    await click('p3');
    await page.waitForTimeout(200);
    await click('go4');
    await page.waitForTimeout(200);
    check('while dirty: a same-page link and navigate() are refused', await read(), { url: g0.url, page: g0.page, entries: g0.entries, marker: 1 });
    // (history.back(), not page.goBack(), which waits for a navigation the guard prevents)
    await page.evaluate(() => history.back());
    await page.waitForTimeout(400);
    check('while dirty: Back is refused', await read(), { url: g0.url, page: g0.page, marker: 1 });
    // a link to another site (another origin here) and one with rel="external": the browser's, but refused too
    await page.evaluate((port) => {
      for (const [id, href, rel] of [['away', `http://localhost:${port}/other.html`, ''], ['ext', '/other.html', 'external']]) {
        const a = Object.assign(document.createElement('a'), { id, href, textContent: id });
        if (rel) a.rel = rel;
        document.body.append(a);
      }
    }, new URL(base).port);
    await page.evaluate(() => { document.getElementById('away').click(); document.getElementById('ext').click(); });
    await page.waitForTimeout(500);
    check('while dirty: a link to another site and rel="external" are refused', await read(), { url: g0.url, page: g0.page, marker: 1 });
    check('the guard ran for each', { more: (await guarded()) - s0 >= 3 }, { more: true });
    await click('clean');
    await click('p3');
    await until(() => document.getElementById('page').textContent === '3');
    check('once clean: the link goes', await read(), { page: '3', marker: 1 });

    await Promise.all([page.waitForURL(base + '/other/', { timeout: 5000 }), click('other')]);
    check('a link to another page: a page load', { marker: await page.evaluate(() => window.__marker ?? null), loads: [...loads] }, { marker: null, loads: ['/', '/other/'] });
  } catch (e) { steps.push(`✗ ${e.message.split('\n')[0]}`); failed++; }
  if (errors.length) { steps.push(`✗ errors: ${JSON.stringify(errors)}`); failed++; }
  console.log(`${name}:\n  ${steps.join('\n  ')}`);
  await browser.close();
}
server.close();
process.exit(failed ? 1 : 0);
