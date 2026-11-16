// What the swap would rely on, in each engine: a page that intercepts same-origin navigations and logs them.
const pw = require('playwright');
const { createServer } = require('node:http');
const PAGE = (name) => `<!doctype html><title>${name}</title>
<a id="link" href="/two">two</a> <a id="hash" href="#h">hash</a> <a id="dl" href="/file" download>dl</a>
<button id="btn">btn</button><div style="height:5000px"></div><p id="h">h</p>
<script>
window.log = [];
const use = new URLSearchParams(location.search).get('precommit');
navigation.addEventListener('navigate', (e) => {
  const rec = { type: e.navigationType, to: new URL(e.destination.url).pathname + new URL(e.destination.url).hash, can: e.canIntercept,
    hash: e.hashChange, dl: e.downloadRequest, src: e.sourceElement?.id ?? null, user: e.userInitiated, info: e.info ?? null,
    index: e.destination.index, sameDoc: e.destination.sameDocument };
  log.push(rec);
  if (!e.canIntercept || e.hashChange || e.downloadRequest || e.navigationType == 'reload') return;
  // the swap: a slow fetch, then the content changes
  const work = async () => { await new Promise((r) => setTimeout(r, 300)); document.title = 'swapped ' + rec.to; };
  if (use && 'precommitHandler' in NavigateEvent.prototype || (use && typeof NavigationPrecommitController != 'undefined')) {
    e.intercept({ precommitHandler: async () => { rec.urlDuringPrecommit = location.pathname; await new Promise((r) => setTimeout(r, 300)); }, handler: work, scroll: 'after-transition' });
  } else e.intercept({ handler: work, scroll: 'after-transition' });
  rec.urlAfterIntercept = location.pathname;
  e.signal.addEventListener('abort', () => { rec.aborted = true; });
});
</script>`;
const srv = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE(req.url)); });
srv.listen(0, async () => {
  const base = 'http://127.0.0.1:' + srv.address().port;
  for (const w of ['chromium', 'firefox', 'webkit']) {
    const b = await pw[w].launch(), p = await b.newPage(), out = {};
    const log = () => p.evaluate(() => log.splice(0));
    const settle = () => p.waitForTimeout(500);
    await p.goto(base + '/');
    await p.evaluate(() => { window.__doc = 1; scrollTo(0, 900); });
    await p.waitForTimeout(100);
    await p.click('#link'); await settle();
    out.link = { ...(await log())[0], doc: await p.evaluate(() => window.__doc), url: new URL(p.url()).pathname, title: await p.title() };
    await p.evaluate(() => scrollTo(0, 200)); await p.waitForTimeout(100);
    await p.goBack(); await settle();
    out.back = { ...(await log())[0], doc: await p.evaluate(() => window.__doc), y: await p.evaluate(() => scrollY) };
    await p.evaluate(() => location.assign('/three')); await settle();
    out.assign = { ...(await log())[0], doc: await p.evaluate(() => window.__doc) };
    await p.evaluate(() => navigation.navigate('/four', { info: { trigger: 'btn' } })); await settle();
    out.navigateInfo = (await log())[0];
    await p.click('#hash'); await settle();
    out.hash = (await log())[0];
    await p.evaluate(() => { const a = document.getElementById('dl'); a.click(); }); await settle();
    out.download = (await log())[0] ?? 'no event';
    // two navigations in a row: the first is aborted
    await p.evaluate(() => { navigation.navigate('/five'); navigation.navigate('/six'); }); await settle();
    out.twoInARow = (await log()).map((x) => ({ to: x.to, aborted: !!x.aborted }));
    // precommit: does the URL wait for the precommit handler?
    await p.goto(base + '/?precommit=1'); await p.waitForTimeout(100);
    await p.click('#link');
    await p.waitForTimeout(100);
    const during = new URL(p.url()).pathname;
    await settle();
    out.precommit = { supported: await p.evaluate(() => typeof NavigationPrecommitController != 'undefined'), urlWhileWaiting: during, ...((await log())[0] ?? {}) };
    // reload: an event, not to be intercepted
    await p.reload(); await p.waitForTimeout(200);
    out.afterReload = await p.evaluate(() => window.__doc ?? null);
    console.log(w, JSON.stringify(out, null, 1));
    await b.close();
  }
  srv.close();
});
