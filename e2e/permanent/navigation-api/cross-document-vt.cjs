// Whether a page load between two pages that opt in with `@view-transition { navigation: auto }` runs a
// view transition (pagereveal's viewTransition), and whether the rule is readable from script.
const pw = require('playwright');
const { createServer } = require('node:http');
const PAGE = (n) => `<!doctype html><title>${n}</title><style>@view-transition { navigation: auto; }</style>
<script>addEventListener('pagereveal', (e) => sessionStorage.setItem('vt:' + location.pathname, String(!!e.viewTransition)));</script>
<a id="next" href="/two">two</a>`;
const srv = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE(req.url)); });
srv.listen(0, async () => {
  for (const w of ['chromium', 'firefox', 'webkit']) {
    const b = await pw[w].launch(), p = await b.newPage();
    await p.goto('http://127.0.0.1:' + srv.address().port + '/one');
    await p.evaluate(() => document.getElementById('next').click());
    await p.waitForURL(/\/two$/); await p.waitForTimeout(300);
    const r = await p.evaluate(() => ({ pagereveal: 'onpagereveal' in window, transitionOnLoad: sessionStorage.getItem('vt:/two'), ruleReadable: typeof CSSViewTransitionRule != 'undefined' }));
    console.log(w, JSON.stringify(r));
    await b.close();
  }
  srv.close();
});
