// The table in packages/sinter-markdown/docs/markdown.md ("Performance"): the article (data.mjs) from an API in
// headless Chromium over loopback, served gzipped, one fresh context per run, the three pages interleaved, median
// of RUNS (21). Build first: npm ci && npm run build (in this folder; the repository's `npm run build` before).
//   node measure.mjs
//   THROTTLE=1 node measure.mjs     slow 4G (150 ms round trip, 1.6 Mbit/s down) and the CPU 4× slower, as Lighthouse's mobile
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { server } from './server.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const RUNS = Number(process.env.RUNS ?? 21);
const PAGES = { article: '/article/', island: '/island/', tree: '/tree/' };
const med = (a) => { const s = [...a].sort((x, y) => x - y); return +s[Math.floor(s.length / 2)].toFixed(1); };
const srv = await server();
const browser = await chromium.launch();

async function load(path) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text()); });
  await page.addInitScript(() => {
    const w = window; w.__m = { lcp: 0, last: 0 };
    new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__m.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
    new MutationObserver(() => { w.__m.last = performance.now(); }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    document.addEventListener('securitypolicyviolation', (e) => w.__m.csp = e.violatedDirective);
  });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  if (process.env.THROTTLE) {
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  }
  await page.goto(srv.url + path, { waitUntil: 'load' });
  // quiet: no DOM change for 300 ms
  await page.waitForFunction(() => window.__m.last && performance.now() - window.__m.last > 300, null, { timeout: 30000, polling: 50 });
  const r = await page.evaluate(() => {
    const main = document.querySelector('main'), count = { elements: 0, comments: 0 };
    const walk = document.createTreeWalker(main, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) n.nodeType === 8 ? count.comments++ : n.localName !== 'template' && count.elements++;
    const scripts = performance.getEntriesByType('resource').filter((e) => /\.js$/.test(e.name)).map((e) => new URL(e.name).pathname);
    return { lcp: window.__m.lcp, csp: window.__m.csp, scripts, ...count };
  });
  const m = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
  await ctx.close();
  if (r.csp) errors.push(`CSP: ${r.csp}`);
  return { ...r, scriptMs: m.ScriptDuration * 1000, errors };
}

const runs = Object.fromEntries(Object.keys(PAGES).map((k) => [k, []]));
for (let i = 0; i < RUNS; i++) for (const [k, p] of Object.entries(PAGES)) runs[k].push(await load(p));
const gz = (s) => gzipSync(s, { level: 9 }).length;
const kB = (n) => `${(n / 1000).toFixed(1)} kB`;
const rows = Object.entries(runs).map(([k, rr]) => {
  const one = rr.at(-1);
  // what the page's scripts weigh, gzip -9: the files it loaded from the build
  const js = [...new Set(one.scripts)].reduce((s, f) => s + gz(readFileSync(new URL(`./dist${f}`, import.meta.url))), 0);
  const response = gz(k === 'tree' ? srv.bodies['/api/tree'] : srv.bodies['/api/article']);
  return { page: k, lcp: med(rr.map((x) => x.lcp)), scriptMs: med(rr.map((x) => x.scriptMs)), js: kB(js), response: kB(response), elements: one.elements, comments: one.comments, errors: [...new Set(rr.flatMap((x) => x.errors))] };
});
console.log(JSON.stringify({ date: new Date().toISOString().slice(0, 10), runs: RUNS, throttled: !!process.env.THROTTLE, markdownBytes: JSON.parse(srv.bodies['/api/article']).body.length, rows }, null, 2));
await browser.close();
await srv.close();
