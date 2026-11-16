// Swaps and data-sn-permanent end to end (`sinter({ swap: true })`, docs/proposals/swap-navigation.md), in
// Chromium, Firefox and WebKit through Playwright: builds the pages, serves them and runs the scenario in
// each. A browser that does not start is a failure under CI (`CI` set), else reported as skipped. Exits
// non-zero on any failure.
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
let slow = false, plainA = false;
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  // `/control/plain-a`: the next request for `/` answers a page without sinter's module (it cannot swap)
  if (path === '/control/plain-a') { plainA = true; res.writeHead(204); return res.end(); }
  if (plainA && path === '/') { plainA = false; res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><title>no kept element</title><p>none</p>'); }
  // `/control/slow`: the next page answers 600 ms late (a second click while the swap fetches)
  if (path === '/control/slow') { slow = true; res.writeHead(204); return res.end(); }
  if (slow && extname(path) === '' && path !== '/control/') { slow = false; await new Promise((r) => setTimeout(r, 600)); }
  // a page without sinter: what the browser itself does on a reload
  if (path === '/control/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><title>control</title><div style="block-size: 5000px"></div>'); }
  const file = path === '/' ? 'index.html' : /^\/(b|plain|off)\/$/.test(path) ? `${path.slice(1)}index.html` : normalize(path).replace(/^\/+/, '');
  try {
    const body = await readFile(join(here, 'dist', file));
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    // the app's 404 page has the app's CSS, page transitions included (else Chromium reports the transition it skips)
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Not found</title><style>@view-transition { navigation: auto; }</style><h1>Not found</h1>');
  }
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
    pixel: !!document.getElementById('pixel'),
    announced: document.querySelector('body > [role=status]')?.textContent ?? null,
    pages: window.__pages ?? [],
  };
};

let failed = 0;
const browsers = process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'firefox', 'webkit'];
for (const name of browsers) {
  let browser;
  try { browser = await pw[name].launch(); } catch (e) {
    console.log(`${name}: ${process.env.CI ? '✗ did not start' : 'skipped'} (${e.message.split('\n')[0]})`);
    if (process.env.CI) failed++;
    continue;
  }
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // a page load the browser makes (the swap's own fetch is not one)
  const loads = [];
  page.on('request', (r) => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) loads.push(new URL(r.url()).pathname);
    // the <noscript> image of B: requested only if the swap made it live
    if (new URL(r.url()).pathname === '/pixel.gif') loads.push('pixel');
  });
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
    await page.evaluate(() => {
      window.__marker = 1; window.__keep = document.getElementById('keep');
      // per-page app code: an event after each mount
      document.addEventListener('sn-page', (e) => (window.__pages ??= []).push(`${e.detail.kind} ${new URL(e.detail.to).pathname}`));
    });
    await page.fill('#keep textarea', 'kept text');
    await page.evaluate(() => { document.getElementById('scroller').scrollTop = 120; });
    await page.click('#inc');
    check('A loads', await page.evaluate(read), { title: 'A: Alpha', description: ['about alpha'], heading: 'Alpha', count: 'A 1', outline: 'none' });

    await page.click('#to-b');
    await settle(() => location.pathname === '/b/' && document.title === 'B: Beta' && document.querySelectorAll('#items li').length === 3);
    await page.click('#inc');
    check('link to B swaps', await page.evaluate(read), {
      path: '/b/', marker: 1, kept: true, notes: 'kept text', scroll: 120, title: 'B: Beta', titles: 1, description: ['about beta'],
      robots: 1, outline: 'solid', heading: 'Beta', items: 3, count: 'B 2', duplicateIds: [], pixel: false, pages: ['push /b/'],
    });
    await settle(() => document.querySelector('body > [role=status]')?.textContent === 'B: Beta');
    check('the new title is announced', await page.evaluate(read), { announced: 'B: Beta' });

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

    // the last click wins: a link to the page shown, while the swap to A is pending, swaps B in again
    await page.evaluate(() => { window.__pages = []; document.getElementById('to-a').click(); document.getElementById('to-b').click(); });
    await settle(() => window.__pages.length && document.title === 'B: Beta' && document.querySelectorAll('#items li').length === 3);
    // (a link to the URL shown replaces the entry, as the browser does with a load)
    check('two clicks: the last one wins', await page.evaluate(read), { path: '/b/', marker: 1, kept: true, title: 'B: Beta', items: 3, duplicateIds: [], pages: ['replace /b/'] });
    check('still one page load, and no <noscript> request', { loads: [...loads] }, { loads: ['/'] });

    // what is left to the browser: a link with data-sn-swap="off", a page with it on <html>, and links from that page
    await Promise.all([page.waitForEvent('load', { timeout: 5000 }), page.click('#to-b-load')]);
    await settle(() => document.title === 'B: Beta');
    check('a link with data-sn-swap="off" loads its page', await page.evaluate(read), { path: '/b/', marker: null });
    await page.evaluate(() => { window.__marker = 8; });
    await Promise.all([page.waitForEvent('load', { timeout: 5000 }), page.click('#to-off')]);
    check('a page with <html data-sn-swap="off"> is loaded', await page.evaluate(() => ({ path: location.pathname, marker: window.__marker ?? null, title: document.title })), { path: '/off/', marker: null, title: 'Off' });
    await page.evaluate(() => { window.__marker = 9; });
    await Promise.all([page.waitForEvent('load', { timeout: 5000 }), page.click('#to-b')]);
    await settle(() => document.title === 'B: Beta');
    check('and a link from it is a page load', await page.evaluate(read), { path: '/b/', marker: null, title: 'B: Beta' });

    // a page that is not there (a 404): a page load
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
    const vt = await p2.evaluate(() => !!document.startViewTransition && typeof CSSViewTransitionRule != 'undefined');
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
      // the URL of the first had committed (the transition runs after it, as a load's paint does): two
      // entries, as with page loads; what counts is that its content never came
      const got = await p2.evaluate((n) => ({ path: location.pathname, entries: history.length - n, marker: window.__marker, heading: document.getElementById('heading')?.textContent, items: document.querySelectorAll('#items li').length }), before);
      check('a click during the transition: only the last navigation commits its page', got, { path: '/plain/', entries: 2, marker: 4, heading: 'Plain', items: 0 });
    } else steps.push('- a click during the transition: no page transitions in this browser (the swap starts none either)');

    // a second click while the first page is still fetched: where the browser holds the URL until the page
    // is ready (precommitHandler), the first never gets an entry, as with page loads
    await p2.evaluate(() => document.getElementById('to-a').click());
    await ready('/', 'A: Alpha');
    const n0 = await p2.evaluate(() => history.length);
    await p2.request.post(base + '/control/slow');
    await p2.evaluate(() => document.getElementById('to-b').click());
    await p2.waitForTimeout(150);
    const during = await p2.evaluate(() => location.pathname);
    await p2.evaluate(() => document.getElementById('to-plain').click());
    await ready('/plain/', 'Plain');
    await p2.waitForTimeout(800);
    const fetched = await p2.evaluate((n) => ({ entries: history.length - n, heading: document.getElementById('heading')?.textContent }), n0);
    if (during === '/') check('a click while the page is fetched: one entry, the last page', fetched, { entries: 1, heading: 'Plain' });
    else { check('a click while the page is fetched: the last page', fetched, { heading: 'Plain' }); steps.push(`- the browser commits the URL before the page is ready (${fetched.entries} entries, as before precommitHandler)`); }
  } catch (e) { steps.push(`✗ ${e.message.split('\n')[0]}`); failed++; }

  // the second review's findings, each as found
  const p3 = await browser.newPage();
  p3.on('pageerror', (e) => errors.push(e.message));
  const at = (path, title) => p3.waitForFunction(([p, t]) => location.pathname === p && document.title === t, [path, title], { timeout: 5000 }).catch(() => {});
  const view = () => p3.evaluate(() => ({ path: location.pathname, marker: window.__marker ?? null, index: navigation.currentEntry?.index, entries: history.length, q: document.getElementById('q')?.textContent ?? null }));
  try {
    // a traversal that cannot swap is a reload of that entry, not a new one
    await p3.goto(base + '/');
    await at('/', 'A: Alpha');
    await p3.evaluate(() => { window.__marker = 5; document.getElementById('to-b').click(); });
    await at('/b/', 'B: Beta');
    await p3.evaluate(() => document.getElementById('to-plain').click());
    await at('/plain/', 'Plain');
    const before = await view();
    await p3.request.post(base + '/control/plain-a');
    await Promise.all([p3.waitForEvent('load', { timeout: 5000 }), p3.evaluate(() => history.go(-2))]);
    await at('/', 'A: Alpha');
    const back = await view();
    check('a traversal that cannot swap reloads that entry, no new one', { path: back.path, index: back.index, entries: back.entries, marker: back.marker }, { path: '/', index: 0, entries: before.entries, marker: null });

    // after a swapped Back, the next Back within the page is the core's: `$url` read again
    await p3.evaluate(() => { window.__marker = 6; document.getElementById('to-b').click(); });
    await at('/b/', 'B: Beta');
    await p3.goBack();
    await at('/', 'A: Alpha');
    await p3.waitForTimeout(200);
    await p3.evaluate(() => document.getElementById('same').click());
    await p3.waitForFunction(() => location.search === '?q=1' && document.getElementById('q')?.textContent === '1', null, { timeout: 5000 }).catch(() => {});
    await p3.goBack();
    await p3.waitForFunction(() => location.search === '', null, { timeout: 5000 }).catch(() => {});
    await p3.waitForTimeout(200);
    const q = await view();
    check('Back after a swapped Back reads $url again', { path: q.path, q: q.q, marker: q.marker }, { path: '/', q: 'none', marker: 6 });

    // a GET form and a link to another site are the browser's: page loads
    await Promise.all([p3.waitForEvent('load', { timeout: 5000 }), p3.evaluate(() => document.getElementById('get-go').click())]);
    await at('/b/', 'B: Beta');
    check('a GET form loads the page', { path: (await view()).path, marker: (await view()).marker }, { path: '/b/', marker: null });
    await p3.goto(base + '/');
    await at('/', 'A: Alpha');
    await p3.evaluate(() => { window.__marker = 7; });
    await Promise.all([p3.waitForEvent('load', { timeout: 5000 }), p3.evaluate(() => document.getElementById('external').click())]);
    await at('/b/', 'B: Beta');
    check('rel="external" loads the page', { path: (await view()).path, marker: (await view()).marker }, { path: '/b/', marker: null });

    // the fade: where the stylesheet asks for page transitions, a swap has one; under reduced motion none
    const counted = async (reduced) => {
      await p3.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
      await p3.goto(base + '/');
      await at('/', 'A: Alpha');
      await p3.evaluate(() => {
        window.__vt = 0;
        const start = document.startViewTransition;
        if (start) document.startViewTransition = function (...a) { window.__vt++; return start.apply(document, a); };
        document.getElementById('to-b').click();
      });
      await at('/b/', 'B: Beta');
      return p3.evaluate(() => window.__vt);
    };
    // a morph across a swap, the kept element held still, and the types: what each transition names and is typed
    await p3.emulateMedia({ reducedMotion: 'no-preference' });
    if (await p3.evaluate(() => typeof CSSViewTransitionRule != 'undefined')) {
      await p3.goto(base + '/');
      await at('/', 'A: Alpha');
      const watch = () => {
        window.__vts = [];
        const start = document.startViewTransition;
        document.startViewTransition = function (o) {
          const t = start.call(document, o), rec = { types: [], names: [] };
          window.__vts.push(rec);
          // the types once the swap set them; the names as they are set, before each snapshot
          t.ready.then(() => { rec.types = [...(t.types ?? [])]; }, () => {});
          new MutationObserver((ms) => {
            for (const m of ms) {
              const n = m.target.style?.viewTransitionName;
              if (n && n !== 'none') rec.names.push(`${m.target.id || m.target.localName}:${n}:${m.target.style.getPropertyValue('view-transition-class')}`);
            }
          }).observe(document, { attributes: true, attributeFilter: ['style'], subtree: true });
          return t;
        };
      };
      await p3.evaluate(watch);
      await p3.evaluate(() => document.getElementById('to-b-morph').click());
      await at('/b/', 'B: Beta');
      await p3.waitForTimeout(400);
      const there = await p3.evaluate(() => window.__vts);
      await p3.evaluate(watch);
      await p3.goBack();
      await at('/', 'A: Alpha');
      await p3.waitForTimeout(400);
      const back = await p3.evaluate(() => window.__vts);
      // the pair's names are equal on both elements, the kept element's is its own
      const names = (r) => {
        const got = Object.fromEntries((r?.names ?? []).map((x) => x.split(':')).map(([id, n, c]) => [id, [n, c]]));
        return [...Object.keys(got)].sort().map((id) => `${id}:${got[id][0] === got.morph?.[0] ? 'pair' : got[id][0] === got.keep?.[0] ? 'own' : '?'}:${got[id][1]}`);
      };
      check('a morph across a swap; the kept element held still; the types', {
        there: there.length, types: there[0]?.types, names: names(there[0]),
        backTypes: back[0]?.types, backNames: names(back[0]),
      }, {
        there: 1, types: ['sn-push'], names: ['heading:pair:sn-transition', 'keep:own:sn-keep', 'morph:pair:sn-transition'],
        backTypes: ['sn-traverse', 'sn-back'], backNames: ['heading:pair:sn-transition', 'keep:own:sn-keep', 'morph:pair:sn-transition'],
      });
    } else steps.push('- a morph across a swap: no page transitions in this browser');
    const readable = await p3.evaluate(() => typeof CSSViewTransitionRule != 'undefined');
    const withRule = await counted(false), reduced = await counted(true);
    if (readable) check('a swap transitions as the stylesheet asks, not under reduced motion', { withRule, reduced }, { withRule: 1, reduced: 0 });
    else check('no page transitions in this browser: a swap starts none', { withRule, reduced }, { withRule: 0, reduced: 0 });
  } catch (e) { steps.push(`✗ ${e.message.split('\n')[0]}`); failed++; }
  if (errors.length) { steps.push(`✗ errors: ${JSON.stringify(errors)}`); failed++; }
  console.log(`${name}:\n  ${steps.join('\n  ')}`);
  await browser.close();
}
server.close();
process.exit(failed ? 1 : 0);
