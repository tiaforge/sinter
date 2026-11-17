// focusReset under intercept(), and the back/forward cache for a document whose entries were intercepted.
const pw = require('playwright');
const { createServer } = require('node:http');
const PAGE = (path) => `<!doctype html><title>${path}</title>
<nav><a id="to-a" href="/a">a</a> <a id="out" href="/outside">out of the app</a></nav>
<input id="field"><main id="m"><h1>${path}</h1></main>
<script>
window.log = window.log || [];
if (!location.pathname.startsWith('/outside') && !location.pathname.startsWith('/control')) navigation.addEventListener('navigate', (e) => {
  if (!e.canIntercept || e.hashChange || e.downloadRequest || e.navigationType == 'reload' || new URL(e.destination.url).pathname.startsWith('/outside')) return;
  const mode = new URLSearchParams(location.search).get('focus') || 'after-transition';
  e.intercept({ focusReset: mode, scroll: 'manual', async handler() {
    await new Promise((r) => setTimeout(r, 100));
    m.innerHTML = '<h1>' + new URL(e.destination.url).pathname + '</h1>';
  } });
});
addEventListener('pageshow', (e) => log.push('pageshow persisted=' + e.persisted));
</script>`;
const srv = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-cache' }); res.end(PAGE(new URL(req.url, 'http://x').pathname)); });
srv.listen(0, async () => {
  const base = 'http://127.0.0.1:' + srv.address().port;
  for (const w of ['chromium', 'firefox', 'webkit']) {
    const b = await pw[w].launch(), p = await b.newPage(), out = {};
    const active = () => p.evaluate(() => document.activeElement === document.body ? 'body' : document.activeElement?.id || document.activeElement?.localName);
    // focusReset 'after-transition' (the default): focus moves to the document as after a load
    await p.goto(base + '/');
    await p.focus('#field');
    await p.evaluate(() => document.getElementById('to-a').click()); await p.waitForTimeout(400);
    out.afterTransition = await active();
    // with the focus on the link that was clicked (a keyboard user)
    await p.goto(base + '/');
    await p.focus('#to-a'); await p.keyboard.press('Enter'); await p.waitForTimeout(400);
    out.afterTransitionFromLink = await active();
    // focusReset 'manual': focus stays where it was
    await p.goto(base + '/?focus=manual');
    await p.focus('#field');
    await p.evaluate(() => document.getElementById('to-a').click()); await p.waitForTimeout(400);
    out.manual = await active();
    // the back/forward cache: an intercepted entry, then a page load out, then Back
    await p.goto(base + '/');
    await p.evaluate(() => { window.__doc = 'kept'; document.getElementById('to-a').click(); }); await p.waitForTimeout(400);
    await p.evaluate(() => document.getElementById('out').click()); await p.waitForLoadState('load'); await p.waitForTimeout(300);
    await p.goBack(); await p.waitForTimeout(800);
    out.bfcache = { path: await p.evaluate(() => location.pathname), sameDocument: await p.evaluate(() => window.__doc === 'kept'), heading: await p.evaluate(() => document.querySelector('h1')?.textContent), log: await p.evaluate(() => window.log) };
    // the control: the same steps on a page with no listener and no intercepted entry
    await p.goto(base + '/control');
    await p.evaluate(() => { window.__doc = 'kept'; document.getElementById('out').click(); }); await p.waitForLoadState('load'); await p.waitForTimeout(300);
    await p.goBack(); await p.waitForTimeout(800);
    out.bfcacheControl = { sameDocument: await p.evaluate(() => window.__doc === 'kept'), log: await p.evaluate(() => window.log) };
    console.log(w, JSON.stringify(out));
    await b.close();
  }
  srv.close();
});
