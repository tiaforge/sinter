// Scroll with intercept({ scroll: 'after-transition' }): the browser restores each entry's position once the
// handler's promise settles. The handler swaps in short content first and grows it later, as a page whose
// data arrives after its markup does.
const pw = require('playwright');
const { createServer } = require('node:http');
const PAGE = `<!doctype html><title>x</title><nav><a id="to-a" href="/a">a</a> <a id="to-b" href="/b">b</a></nav><main id="m"><div style="height:5000px">first</div></main>
<script>
navigation.addEventListener('navigate', (e) => {
  if (!e.canIntercept || e.hashChange || e.downloadRequest || e.navigationType == 'reload') return;
  e.intercept({ scroll: 'after-transition', async handler() {
    await new Promise((r) => setTimeout(r, 100));          // the fetch
    m.innerHTML = '<div style="height:600px">markup</div>'; // the new page's markup, before its data
    await new Promise((r) => setTimeout(r, 150));          // its first loads
    m.innerHTML = '<div style="height:5000px">' + location.pathname + '</div>';
  } });
});
</script>`;
const srv = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
srv.listen(0, async () => {
  const base = 'http://127.0.0.1:' + srv.address().port;
  for (const w of ['chromium', 'firefox', 'webkit']) {
    const b = await pw[w].launch(), p = await b.newPage();
    const y = () => p.evaluate(() => Math.round(scrollY));
    const click = (id) => p.evaluate((i) => document.getElementById(i).click(), id);
    await p.goto(base + '/');
    await p.evaluate(() => scrollTo(0, 900)); await p.waitForTimeout(100);
    await click('to-a'); await p.waitForTimeout(600);
    const pushY = await y();
    await p.evaluate(() => scrollTo(0, 300)); await p.waitForTimeout(100);
    await click('to-b'); await p.waitForTimeout(600);
    await p.evaluate(() => scrollTo(0, 450)); await p.waitForTimeout(100);
    await p.goBack(); await p.waitForTimeout(700);
    const back1 = await y();
    await p.goBack(); await p.waitForTimeout(700);
    const back2 = await y();
    await p.goForward(); await p.waitForTimeout(700);
    const fwd = await y();
    await p.evaluate(() => scrollTo(0, 650)); await p.waitForTimeout(100);
    await p.reload(); await p.waitForTimeout(500);
    const reload = await y();
    console.log(w, JSON.stringify({ pushStartsAtTop: pushY, backTo_a_want300: back1, backTo_first_want900: back2, forwardTo_a_want300: fwd, reloadWant650: reload }));
    await b.close();
  }
  srv.close();
});
