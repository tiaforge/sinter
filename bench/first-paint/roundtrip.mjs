import { chromium } from 'playwright';
const runs = +process.argv[2];
const variants = process.argv.slice(3).map((x) => x.split('='));
const pages = [['home', '/', '.article-preview h1'], ['article', '/article/article-3', '.article-page .banner h1']];
const nets = { fast: null, slow4g: { latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8, cpu: 4 } };
const init = (sel) => {
  const t = (window.__m = { lcp: 0, cls: 0 });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) t.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) t.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
  const f = () => { const el = document.querySelector(sel); if (el && el.textContent.trim()) { t.data = performance.now(); return; } requestAnimationFrame(f); };
  requestAnimationFrame(f);
};
const b = await chromium.launch();
for (const [net, cond] of Object.entries(nets)) for (const [page, path, sel] of pages) {
  const cell = {};
  for (let i = 0; i < runs; i++) for (const [name, port] of (i % 2 ? [...variants].reverse() : variants)) {
    const ctx = await b.newContext();
    await ctx.route('https://code.ionicframework.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    // fonts out of the comparison: sinter's build serves Google Fonts itself, Qwik links them
    await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    await ctx.route('https://fonts.gstatic.com/**', (r) => r.fulfill({ status: 404, body: '' }));
    await ctx.route(/\/assets\/.*\.woff2$/, (r) => r.fulfill({ status: 404, body: '' }));
    // the same fonts for all: none (sinter's build serves Google Fonts itself, as @font-face in its CSS; Qwik's link is stubbed)
    await ctx.route(/:\d+\/assets\/[^/]+\.css$/, async (r) => { const res = await r.fetch(); r.fulfill({ response: res, body: (await res.text()).replace(/@font-face\s*\{[^}]*\}/g, '') }); });
    const p = await ctx.newPage();
    let api = 0; p.on('request', (r) => { if (r.url().includes(':4400/') && r.method() == 'GET') api++; });
    await p.addInitScript(init, sel);
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('Performance.enable');
    if (cond) { await cdp.send('Network.emulateNetworkConditions', { offline: false, ...cond }); await cdp.send('Emulation.setCPUThrottlingRate', { rate: cond.cpu }); }
    // Qwik City's URLs end in a slash (without it, a redirect first)
    await p.goto('http://localhost:' + port + (name.startsWith('qwik') && path != '/' ? path + '/' : path), { waitUntil: 'load' });
    await p.waitForFunction(() => window.__m.data, null, { timeout: 15000 }).catch(() => {});
    await p.waitForTimeout(300);
    const r = await p.evaluate(() => ({ ...window.__m, fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime, ttfb: performance.getEntriesByType('navigation')[0].responseStart, html: performance.getEntriesByType('navigation')[0].transferSize }));
    const m = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
    Object.assign(r, { api, script: m.ScriptDuration * 1000 });
    (cell[name] ??= []).push(r);
    await ctx.close();
  }
  const med = (a) => { a = a.filter((x) => x != null).sort((x, y) => x - y); return a.length ? Math.round(a[a.length >> 1]) : null; };
  const line = { net, page };
  for (const [name] of variants) { const c = cell[name]; line[name] = ['ttfb', 'fcp', 'data', 'lcp'].map((k) => k + ' ' + med(c.map((x) => x[k]))).join(' ') + ' cls ' + (c.reduce((a, x) => a + x.cls, 0) / c.length).toFixed(3); }
  console.log(JSON.stringify(line));
}
await b.close();
