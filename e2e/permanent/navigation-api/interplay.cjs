const pw = require('playwright');
const { createServer } = require('node:http');
const PAGE = `<!doctype html><title>x</title><a id="to-a" href="/a">a</a>
<script>
window.log = [];
addEventListener('popstate', () => log.push('popstate ' + location.pathname + location.search));
navigation.addEventListener('navigate', (e) => {
  log.push('navigate ' + e.navigationType + ' ' + new URL(e.destination.url).pathname + new URL(e.destination.url).search + ' sameDocument=' + e.destination.sameDocument);
  if (e.destination.sameDocument && e.navigationType != 'traverse') return;   // pushState and the like: left alone
  if (!e.canIntercept || e.hashChange || e.downloadRequest || e.navigationType == 'reload') return;
  e.intercept({ scroll: 'manual', async handler() {} });
});
</script>`;
const srv = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
srv.listen(0, async () => {
  const base = 'http://127.0.0.1:' + srv.address().port;
  for (const w of ['chromium', 'firefox', 'webkit']) {
    const b = await pw[w].launch(), p = await b.newPage();
    await p.goto(base + '/');
    await p.evaluate(() => history.pushState(null, '', '?q=1'));   // a $url write
    await p.evaluate(() => document.getElementById('to-a').click()); await p.waitForTimeout(200);
    await p.goBack(); await p.waitForTimeout(300);                    // an intercepted traversal (/a -> /?q=1)
    await p.goBack(); await p.waitForTimeout(300);                    // a traversal between pushState entries (/?q=1 -> /)
    console.log(w, JSON.stringify(await p.evaluate(() => log), null, 0));
    await b.close();
  }
  srv.close();
});
