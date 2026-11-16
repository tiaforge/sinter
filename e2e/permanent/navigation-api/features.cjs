// What each installed engine has of the Navigation API (feature detection only)
const pw = require('playwright');
const { createServer } = require('node:http');
const srv = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>p</title><a id=a href="/two">two</a><div style="height:4000px"></div>'); });
srv.listen(0, async () => {
  for (const w of ['chromium', 'firefox', 'webkit']) {
    const b = await pw[w].launch(), p = await b.newPage();
    await p.goto('http://127.0.0.1:' + srv.address().port + '/');
    const f = await p.evaluate(() => {
      const N = globalThis.NavigateEvent?.prototype, H = globalThis.NavigationHistoryEntry?.prototype;
      return {
        navigation: typeof navigation !== 'undefined',
        intercept: !!N && 'intercept' in N,
        scroll: !!N && 'scroll' in N,
        sourceElement: !!N && 'sourceElement' in N,
        hasUAVisualTransition: !!N && 'hasUAVisualTransition' in N,
        canIntercept: !!N && 'canIntercept' in N,
        downloadRequest: !!N && 'downloadRequest' in N,
        formData: !!N && 'formData' in N,
        entryIndex: !!H && 'index' in H,
        entryKey: !!H && 'key' in H,
        transition: typeof navigation !== 'undefined' && 'transition' in navigation,
        activation: typeof navigation !== 'undefined' && 'activation' in navigation,
        precommitHandler: (() => { try { return typeof NavigationPrecommitController !== 'undefined'; } catch { return false; } })(),
        moveBefore: 'moveBefore' in Element.prototype,
        startViewTransition: 'startViewTransition' in document,
        parseHTMLUnsafe: typeof Document.parseHTMLUnsafe === 'function',
      };
    });
    console.log(w, b.version(), JSON.stringify(f));
    await b.close();
  }
  srv.close();
});
