// Whether the URL waits for intercept()'s precommitHandler, measured inside the page (no Playwright
// timing in between): the handler takes 400 ms; the URL is read at 100 ms and after it.
const pw = require('playwright');
const { createServer } = require('node:http');
const PAGE = `<!doctype html><title>x</title><a id="to-a" href="/a">a</a>
<script>
navigation.addEventListener('navigate', (e) => {
  if (!e.canIntercept || e.destination.sameDocument) return;
  e.intercept({ async precommitHandler() { await new Promise((r) => setTimeout(r, 400)); }, async handler() {} });
});
</script>`;
const srv = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
srv.listen(0, async () => {
  for (const w of ['chromium', 'firefox', 'webkit']) {
    const b = await pw[w].launch(), p = await b.newPage();
    await p.goto('http://127.0.0.1:' + srv.address().port + '/');
    const r = await p.evaluate(() => new Promise((done) => {
      const out = {};
      document.getElementById('to-a').click();
      setTimeout(() => { out.at100 = location.pathname; }, 100);
      setTimeout(() => { out.at600 = location.pathname; done(out); }, 600);
    }));
    console.log(w, JSON.stringify(r));
    await b.close();
  }
  srv.close();
});
