// data-sn-permanent end to end, in Chromium, Firefox and WebKit (Playwright; a browser that is not
// installed is reported as skipped): builds the two pages, serves them and runs the scenario in each.
// Exits non-zero on any failure.
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

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  // a page without sinter: what the browser itself does on a reload
  if (path === '/control/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><title>control</title><div style="block-size: 5000px"></div>'); }
  const file = path === '/' ? 'index.html' : /^\/(b|plain)\/$/.test(path) ? `${path.slice(1)}index.html` : normalize(path).replace(/^\/+/, '');
  try {
    const body = await readFile(join(here, 'dist', file));
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>Not found</title><h1>Not found</h1>'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

/** what the scenario reads of the page */
const read = () => {
  const keep = document.getElementById('keep');
  const ids = [...document.querySelectorAll('[data-sn]')].map((x) => x.getAttribute('data-sn'));
  return {
    path: location.pathname, marker: window.__marker ?? null, kept: window.__keep === keep,
    notes: keep.querySelector('textarea').value, scroll: document.getElementById('scroller').scrollTop,
    title: document.title, titles: document.head.querySelectorAll('title').length,
    description: [...document.head.querySelectorAll('meta[name="description"]')].map((m) => m.content),
    robots: document.head.querySelectorAll('meta[name="robots"]').length,
    outline: getComputedStyle(document.body).outlineStyle,
    heading: document.getElementById('heading')?.textContent ?? null,
    items: document.querySelectorAll('#items li').length,
    count: document.querySelector('#count span')?.textContent ?? null,
    hits: document.getElementById('hits')?.textContent ?? null,
    duplicateIds: ids.filter((x, i) => ids.indexOf(x) !== i),
  };
};

let failed = 0;
const browsers = process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'firefox', 'webkit'];
for (const name of browsers) {
  let browser;
  try { browser = await pw[name].launch(); } catch (e) { console.log(`${name}: skipped (${e.message.split('\n')[0]})`); continue; }
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // a page load the browser makes (the swap's own fetch is not one)
  const loads = [];
  page.on('request', (r) => { if (r.isNavigationRequest() && r.frame() === page.mainFrame()) loads.push(new URL(r.url()).pathname); });
  page.on('console', (m) => {
    // WebKit refuses Speculation Rules prefetches over http; the 404 page is the one the last step loads
    if (/Prefetch request denied/.test(m.text()) || new URL(m.location().url || base).pathname === '/nope/') return;
    if (['error', 'warning'].includes(m.type())) errors.push(m.text());
  });
  const steps = [];
  const check = (step, got, want) => {
    const bad = Object.entries(want).filter(([k, v]) => JSON.stringify(got[k]) !== JSON.stringify(v));
    steps.push(bad.length ? `✗ ${step}: ${bad.map(([k, v]) => `${k} ${JSON.stringify(got[k])}, want ${JSON.stringify(v)}`).join('; ')}` : `✓ ${step}`);
    if (bad.length) failed++;
  };
  const settle = (fn) => page.waitForFunction(fn, null, { timeout: 5000 }).catch(() => {});
  try {
    await page.goto(base + '/');
    await settle(() => document.title === 'A: Alpha');
    await page.evaluate(() => { window.__marker = 1; window.__keep = document.getElementById('keep'); });
    await page.fill('#keep textarea', 'kept text');
    await page.evaluate(() => { document.getElementById('scroller').scrollTop = 120; });
    await page.click('#inc');
    check('A loads', await page.evaluate(read), { title: 'A: Alpha', description: ['about alpha'], heading: 'Alpha', count: 'A 1', outline: 'none' });

    await page.click('#to-b');
    await settle(() => location.pathname === '/b/' && document.title === 'B: Beta' && document.querySelectorAll('#items li').length === 3);
    await page.click('#inc');
    check('link to B swaps', await page.evaluate(read), {
      path: '/b/', marker: 1, kept: true, notes: 'kept text', scroll: 120, title: 'B: Beta', titles: 1, description: ['about beta'],
      robots: 1, outline: 'solid', heading: 'Beta', items: 3, count: 'B 2', duplicateIds: [],
    });

    await page.goBack();
    await settle(() => location.pathname === '/' && document.title === 'A: Alpha');
    check('Back to A', await page.evaluate(read), {
      path: '/', marker: 1, kept: true, notes: 'kept text', title: 'A: Alpha', titles: 1, description: ['about alpha'],
      robots: 0, outline: 'none', heading: 'Alpha', items: 0, count: 'A 0', duplicateIds: [],
    });

    await page.goForward();
    await settle(() => location.pathname === '/b/' && document.title === 'B: Beta' && document.querySelectorAll('#items li').length === 3);
    check('Forward to B', await page.evaluate(read), { path: '/b/', marker: 1, kept: true, title: 'B: Beta', robots: 1, outline: 'solid', items: 3, duplicateIds: [] });
    // the body's handler is the new page's alone: one click, one hit (B's counter was clicked once before)
    const hits = +(await page.evaluate(() => document.getElementById('hits').textContent));
    await page.click('h1');
    check('the body keeps one handler', await page.evaluate(read), { hits: String(hits + 1) });

    // navigate() in a handler is a visit too
    await page.click('#to-a');
    await settle(() => location.pathname === '/' && document.title === 'A: Alpha' && document.getElementById('go-b'));
    await page.click('#go-b');
    await settle(() => location.pathname === '/b/' && document.title === 'B: Beta' && document.querySelectorAll('#items li').length === 3);
    check('navigate() from a handler swaps', await page.evaluate(read), { path: '/b/', marker: 1, kept: true, robots: 1, items: 3, duplicateIds: [] });
    // a page with nothing bound: the build must still ship its module (the kept element is the reason)
    await page.click('#to-plain');
    await settle(() => location.pathname === '/plain/' && document.title === 'Plain');
    check('to a page with nothing bound', await page.evaluate(read), { path: '/plain/', marker: 1, kept: true, notes: 'kept text', title: 'Plain', titles: 1, description: [], robots: 0, outline: 'none', heading: 'Plain', duplicateIds: [] });
    await page.click('#to-b');
    await settle(() => location.pathname === '/b/' && document.title === 'B: Beta' && document.querySelectorAll('#items li').length === 3);
    check('and from it', await page.evaluate(read), { path: '/b/', marker: 1, kept: true, title: 'B: Beta', description: ['about beta'], robots: 1, items: 3, duplicateIds: [] });
    check('one page load so far', { loads: [...loads] }, { loads: ['/'] });

    // the last click wins: a link to the page shown, while the swap to A is pending, is the browser's
    await Promise.all([page.waitForEvent('load', { timeout: 5000 }), page.evaluate(() => { document.getElementById('to-a').click(); document.getElementById('to-b').click(); })]);
    await settle(() => document.title === 'B: Beta' && document.querySelectorAll('#items li').length === 3);
    check('two clicks: the last one wins', await page.evaluate(read), { path: '/b/', marker: null, title: 'B: Beta', items: 3, duplicateIds: [] });

    // a page without the kept element (here a 404): a page load
    await page.evaluate(() => { window.__marker = 2; const a = document.createElement('a'); a.id = 'away'; a.href = '/nope/'; a.textContent = 'away'; document.body.append(a); });
    await Promise.all([page.waitForURL(base + '/nope/', { timeout: 5000 }), page.click('#away')]);
    check('a page without it loads', { path: new URL(page.url()).pathname, marker: await page.evaluate(() => window.__marker ?? null) }, { path: '/nope/', marker: null });
  } catch (e) { steps.push(`✗ ${e.message.split('\n')[0]}`); failed++; }

  // the page's scroll position and the history (a fresh page: the first one's history is long)
  const p2 = await browser.newPage();
  p2.on('pageerror', (e) => errors.push(e.message));
  const y = () => p2.evaluate(() => Math.round(scrollY));
  const near = (a, b) => Math.abs(a - b) <= 2;
  const ready = (path, title) => p2.waitForFunction(([p, t]) => location.pathname === p && document.title === t, [path, title], { timeout: 5000 }).catch(() => {});
  try {
    // what this browser does on a reload of a page without sinter (headless WebKit restores nothing)
    await p2.goto(base + '/control/');
    await p2.evaluate(() => scrollTo(0, 700));
    await p2.waitForTimeout(150);
    await p2.reload();
    await p2.waitForTimeout(300);
    const restores = near(await y(), 700);
    const reloaded = (step, got, want) => (restores ? check(step, { y: near(got, want) ? want : got }, { y: want }) : steps.push(`- ${step}: the browser restores no position on a reload, even without sinter`));
    // before any swap, a reload is the browser's: it restores the position (opting in must not turn that off)
    await p2.goto(base + '/');
    await ready('/', 'A: Alpha');
    await p2.evaluate(() => scrollTo(0, 700));
    await p2.waitForTimeout(150);
    await p2.reload();
    await ready('/', 'A: Alpha');
    await p2.waitForTimeout(300);
    reloaded('a reload restores the position, before any swap', await y(), 700);

    // each entry keeps its own position: A at 800, B at 300; Back is A at 800, Forward B at 300
    await p2.evaluate(() => { window.__marker = 3; scrollTo(0, 800); });
    await p2.waitForTimeout(150);
    await p2.evaluate(() => document.getElementById('to-b').click());
    await ready('/b/', 'B: Beta');
    check('a link starts the next page at the top', { y: await y() }, { y: 0 });
    await p2.evaluate(() => scrollTo(0, 300));
    await p2.waitForTimeout(150);
    await p2.goBack();
    await ready('/', 'A: Alpha');
    await p2.waitForTimeout(150);
    check('Back restores the page left, not the page leaving', { y: near(await y(), 800) ? 800 : await y(), marker: await p2.evaluate(() => window.__marker) }, { y: 800, marker: 3 });
    await p2.goForward();
    await ready('/b/', 'B: Beta');
    await p2.waitForTimeout(150);
    check('Forward too', { y: near(await y(), 300) ? 300 : await y() }, { y: 300 });

    // a reload of an entry a swap made: the browser's again
    await p2.evaluate(() => scrollTo(0, 500));
    await p2.waitForTimeout(150);
    await p2.reload();
    await ready('/b/', 'B: Beta');
    await p2.waitForTimeout(300);
    reloaded('a reload of a swapped entry restores the position', await y(), 500);

    // a link's #hash: in the address, and its target scrolled to
    await p2.evaluate(() => { window.__marker = 4; scrollTo(0, 0); document.getElementById('to-a').click(); });
    await ready('/', 'A: Alpha');
    await p2.evaluate(() => document.getElementById('to-b-bottom').click());
    await ready('/b/', 'B: Beta');
    await p2.waitForTimeout(150);
    const at = await p2.evaluate(() => ({ hash: location.hash, seen: document.getElementById('bottom').getBoundingClientRect().top < innerHeight, marker: window.__marker }));
    check('a link with a #hash keeps it and scrolls to its target', at, { hash: '#bottom', seen: true, marker: 4 });

    // a second navigation while the first one's transition waits for its update: only the second commits
    const vt = await p2.evaluate(() => !!document.startViewTransition);
    if (vt) {
      await p2.evaluate(() => document.getElementById('to-a').click());
      await ready('/', 'A: Alpha');
      const before = await p2.evaluate(() => history.length);
      await p2.evaluate(() => {
        const start = document.startViewTransition;
        document.startViewTransition = function (f) {
          document.startViewTransition = start;
          const t = start.call(document, f);
          // the user clicks again before the callback runs
          document.getElementById('to-plain').click();
          return t;
        };
        document.getElementById('to-b').click();
      });
      await ready('/plain/', 'Plain');
      await p2.waitForTimeout(500);
      const got = await p2.evaluate((n) => ({ path: location.pathname, entries: history.length - n, marker: window.__marker, heading: document.getElementById('heading')?.textContent, items: document.querySelectorAll('#items li').length }), before);
      check('a click during the transition: only the last navigation commits', got, { path: '/plain/', entries: 1, marker: 4, heading: 'Plain', items: 0 });
    } else steps.push('- a click during the transition: no view transitions in this browser');
  } catch (e) { steps.push(`✗ ${e.message.split('\n')[0]}`); failed++; }
  if (errors.length) { steps.push(`✗ errors: ${JSON.stringify(errors)}`); failed++; }
  console.log(`${name}:\n  ${steps.join('\n  ')}`);
  await browser.close();
}
server.close();
process.exit(failed ? 1 : 0);
