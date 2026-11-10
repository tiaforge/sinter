// home page on slow 4G, at 1x/2x/4x CPU, while the server under test takes 0/50/80 page requests per second
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const runs = +process.argv[2];
const variants = [['middleware', 4358], ['qwik', 4353]];
const sel = '.article-preview h1';
const init = (sel) => {
  const t = (window.__m = { lcp: 0 });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) t.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
  const f = () => { const el = document.querySelector(sel); if (el && el.textContent.trim()) { t.data = performance.now(); return; } requestAnimationFrame(f); };
  requestAnimationFrame(f);
};
const med = (a) => { a = a.filter((x) => x != null).sort((x, y) => x - y); return a.length ? Math.round(a[a.length >> 1]) : null; };
const b = await chromium.launch();
const CPUS = (process.env.CPUS ?? '1,2,4').split(',').map(Number), RATES = (process.env.RATES ?? '0,50,80').split(',').map(Number), MODE = process.env.MODE ?? 'cold';
for (const cpu of CPUS) for (const rate of RATES) {
  const line = { cpu, rate, mode: MODE };
  for (const [name, port] of variants) {
    process.on('exit', () => gen?.kill('SIGTERM'));
    const gen = rate ? spawn('node', ['loadgen.mjs', 'http://localhost:' + port + '/', String(rate)], { stdio: ['ignore', 'pipe', 'inherit'] }) : null;
    let genOut = ''; gen?.stdout.on('data', (d) => (genOut += d));
    await new Promise((r) => setTimeout(r, rate ? 2000 : 0));
    const c = [];
    for (let i = 0; i < runs; i++) {
      const ctx = await b.newContext();
      await ctx.route('https://code.ionicframework.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
      await ctx.route('https://fonts.**/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
      await ctx.route(/:\d+\/assets\/[^/]+\.css$/, async (r) => { const res = await r.fetch(); r.fulfill({ response: res, body: (await res.text()).replace(/@font-face\s*\{[^}]*\}/g, '') }); });
      const p = await ctx.newPage();
      await p.addInitScript(init, sel);
      const cdp = await ctx.newCDPSession(p);
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 });
      if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
      // warm: another page of the site first (its shared files cached), then the home page, a full page load
      if (MODE == 'nav') { await p.goto('http://localhost:' + port + (name == 'qwik' ? '/article/article-3/' : '/article/article-3'), { waitUntil: 'load' }); await p.waitForTimeout(300); }
      // a server past its capacity: a page that has not loaded in 15 s counts as a timeout
      const ok = await p.goto('http://localhost:' + port + '/', { waitUntil: 'load', timeout: 15000 }).then(() => true, () => false);
      if (!ok) { c.push({ timeout: true }); await ctx.close(); continue; }
      await p.waitForFunction(() => window.__m.data, null, { timeout: 15000 }).catch(() => {});
      await p.waitForTimeout(200);
      c.push(await p.evaluate(() => ({ ...window.__m, fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime, ttfb: performance.getEntriesByType('navigation')[0].responseStart })));
      await ctx.close();
    }
    if (gen) { gen.kill('SIGTERM'); await new Promise((r) => gen.on('exit', r)); }
    const g = genOut ? JSON.parse(genOut) : null;
    const to = c.filter((x) => x.timeout).length;
    line[name] = (to ? `timeouts ${to}/${c.length} ` : '') + 'ttfb ' + med(c.map((x) => x.ttfb)) + ' fcp ' + med(c.map((x) => x.fcp)) + ' lcp ' + med(c.map((x) => x.lcp)) + (g ? ' | load p50 ' + g.p50 + ' p90 ' + g.p90 + ' ms' + (g.errors ? ' errors ' + g.errors : '') : '');
  }
  console.log(JSON.stringify(line));
}
await b.close();
