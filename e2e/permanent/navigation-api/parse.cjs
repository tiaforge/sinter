// Which parser keeps what the swap needs of a fetched page: sinter's anchor comments, declarative shadow DOM,
// scripts and attributes. Found: Chromium's `Document.parseHTMLUnsafe(html)` drops comments (Firefox and
// WebKit keep them); with a configuration, `{ sanitizer: {} }`, it keeps everything in all three, and attaches
// declarative shadow DOM, which `DOMParser` does not.
//   node parse.cjs
const pw = require('../../../node_modules/playwright');
(async () => {
  for (const n of ['chromium', 'firefox', 'webkit']) {
    let b;
    try { b = await pw[n].launch(); } catch (e) { console.log(n, 'skipped'); continue; }
    const p = await b.newPage();
    await p.setContent('<p>x</p>');
    console.log(n, await p.evaluate(() => {
      const h = '<!doctype html><body><ul><!--sn 6--><!--/sn--></ul><div><template shadowrootmode="open"><b>s</b></template></div><script type=module src=/a.js></script><p onclick=1 data-sn=3>y</p></body>';
      const read = (d) => ({ comments: d.querySelector('ul').innerHTML, shadow: !!d.querySelector('div').shadowRoot, scripts: d.querySelectorAll('script').length, attrs: d.querySelector('p')?.getAttributeNames().join(' ') });
      return {
        parseHTMLUnsafe: read(Document.parseHTMLUnsafe(h)),
        'parseHTMLUnsafe with { sanitizer: {} }': read(Document.parseHTMLUnsafe(h, { sanitizer: {} })),
        DOMParser: read(new DOMParser().parseFromString(h, 'text/html')),
      };
    }));
    await b.close();
  }
})();
