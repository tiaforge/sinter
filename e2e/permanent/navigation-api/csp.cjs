// Can a document's CSP be replaced? A header policy, then a <meta> added and removed.
const pw = require('playwright');
const { createServer } = require('node:http');
const srv = createServer((req, res) => {
  // the header allows inline styles; a meta later forbids them
  res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "style-src 'self' 'unsafe-inline'; img-src 'none'" });
  res.end('<!doctype html><title>csp</title><p id=p>x</p>');
});
srv.listen(0, async () => {
  for (const w of ['chromium', 'firefox', 'webkit']) {
    const b = await pw[w].launch(), p = await b.newPage();
    await p.goto('http://127.0.0.1:' + srv.address().port + '/');
    const r = await p.evaluate(async () => {
      const styled = () => { const s = document.createElement('style'); s.textContent = '#p{color:rgb(1,2,3)}'; document.head.append(s); const ok = getComputedStyle(document.getElementById('p')).color == 'rgb(1, 2, 3)'; s.remove(); return ok; };
      const img = () => new Promise((r) => { const i = new Image(); i.onload = () => r(true); i.onerror = () => r(false); i.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='; });
      const out = { inlineStyleUnderHeader: styled(), imgUnderHeader: await img() };
      const m = document.createElement('meta'); m.httpEquiv = 'Content-Security-Policy'; m.content = "style-src 'self'"; document.head.append(m);
      out.inlineStyleAfterMetaAdded = styled();
      m.remove();
      out.inlineStyleAfterMetaRemoved = styled();
      const m2 = document.createElement('meta'); m2.httpEquiv = 'Content-Security-Policy'; m2.content = "img-src *"; document.head.append(m2);
      out.imgAfterLooserMeta = await img();
      return out;
    });
    console.log(w, JSON.stringify(r));
    await b.close();
  }
  srv.close();
});
