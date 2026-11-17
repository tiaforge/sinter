// Does parsing a fetched page report its inline styles as violations of the current document's CSP? (a swap
// parses the next page, whose styles carry that page's own nonce, then inserts them with the document's.)
// Found: Chromium reports each inline <style> and style attribute of the parsed page, whatever the parser;
// Firefox and WebKit report none. With the document's nonce on the page's styles before the parse, none.
//   node parse-csp.cjs
const pw = require('../../../node_modules/playwright');
const { createServer } = require('node:http');
const srv = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "style-src 'nonce-abc'; script-src 'nonce-abc'" });
  res.end('<!doctype html><p>x</p>');
});
srv.listen(0, async () => {
  for (const n of ['chromium', 'firefox', 'webkit']) {
    let b;
    try { b = await pw[n].launch(); } catch { console.log(n, 'skipped'); continue; }
    const p = await b.newPage();
    await p.goto('http://127.0.0.1:' + srv.address().port + '/');
    console.log(n, await p.evaluate(async () => {
      const html = '<!doctype html><html><head><style nonce="other">p{color:red}</style></head><body><p style="color:blue">y</p><!--sn 1--></body></html>';
      const out = {};
      const count = async (name, f) => {
        let v = 0;
        const on = () => { v++; };
        addEventListener('securitypolicyviolation', on);
        let d;
        try { d = f(); } catch (e) { out[name] = 'throws'; removeEventListener('securitypolicyviolation', on); return; }
        await new Promise((r) => setTimeout(r, 100));
        removeEventListener('securitypolicyviolation', on);
        out[name] = { violations: v, comments: d.body.innerHTML.includes('<!--sn 1-->') };
      };
      await count('parseHTMLUnsafe', () => Document.parseHTMLUnsafe(html, { sanitizer: {} }));
      await count('DOMParser', () => new DOMParser().parseFromString(html, 'text/html'));
      await count('createHTMLDocument + write', () => { const d = document.implementation.createHTMLDocument(''); d.open(); d.write(html); d.close(); return d; });
      // the swap's way: the page's nonces replaced with the document's before the parse
      await count('DOMParser, nonce replaced', () => new DOMParser().parseFromString(html.replace('nonce="other"', 'nonce="abc"').replace(' style="color:blue"', ''), 'text/html'));
      await count('createHTMLDocument + innerHTML', () => { const d = document.implementation.createHTMLDocument(''); d.documentElement.innerHTML = html.replace(/^<!doctype html><html>|<\/html>$/g, ''); return d; });
      return out;
    }));
    await b.close();
  }
  srv.close();
});
