// browser render cost: main-thread work until the content is painted (LCP) and until load, CPU 4x slower, network unthrottled
import { chromium } from 'playwright';
const runs = +process.argv[2];
const variants = [['static', 4360], ['middleware', 4358], ['qwik', 4353]];
const b = await chromium.launch();
const med = (a) => { a = [...a].sort((x, y) => x - y); return Math.round(a[a.length >> 1]); };
for (const [page, path] of [['home', '/'], ['article', '/article/article-3']]) {
  const cell = {};
  for (let i = 0; i < runs; i++) for (const [name, port] of variants) {
    const ctx = await b.newContext(); const p = await ctx.newPage();
    await ctx.route('https://code.ionicframework.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    await ctx.route('https://fonts.**/**', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    await ctx.route(/:\d+\/assets\/[^/]+\.css$/, async (r) => { const res = await r.fetch(); r.fulfill({ response: res, body: (await res.text()).replace(/@font-face\s*\{[^}]*\}/g, '') }); });
    const cdp = await ctx.newCDPSession(p);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const ev = []; cdp.on('Tracing.dataCollected', (d) => ev.push(...d.value));
    const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,loading,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' });
    await p.goto('http://localhost:' + port + (name == 'qwik' && path != '/' ? path + '/' : path), { waitUntil: 'load' }); await p.waitForTimeout(400);
    await cdp.send('Tracing.end'); await done;
    const main = ev.find((e) => e.name == 'TracingStartedInBrowser')?.args?.data?.frames?.[0]?.processId;
    const lcpE = ev.filter((e) => e.name == 'largestContentfulPaint::Candidate').pop(), loadE = ev.find((e) => e.name == 'MarkLoad' || e.name == 'loadEventEnd');
    const tasks = ev.filter((e) => e.ph == 'X' && e.name == 'RunTask' && e.pid == lcpE?.pid && e.tid == lcpE?.tid);
    const kids = ev.filter((e) => e.ph == 'X' && e.pid == lcpE?.pid && e.tid == lcpE?.tid);
    const until = (end, f) => kids.filter((e) => e.ts + e.dur <= end && f(e)).reduce((a, e) => a + e.dur, 0) / 1000;
    const busy = (end) => tasks.filter((e) => e.ts < end).reduce((a, e) => a + Math.min(e.dur, end - e.ts), 0) / 1000;
    const L = lcpE.ts, E = Math.max(...tasks.map((e) => e.ts + e.dur));
    const r = { busyLcp: busy(L), scriptLcp: until(L, (e) => ['EvaluateScript', 'FunctionCall', 'v8.evaluateModule', 'EvaluateModule', 'RunMicrotasks'].includes(e.name)), layoutLcp: until(L, (e) => ['Layout', 'UpdateLayoutTree', 'Paint', 'PrePaint'].includes(e.name)), busyAll: busy(E) };
    (cell[name] ??= []).push(r);
    await ctx.close();
  }
  for (const [name] of variants) { const c = cell[name]; console.log(page.padEnd(8), name.padEnd(10), 'until content painted (LCP): main thread busy', med(c.map((x) => x.busyLcp)), 'ms, of it script', med(c.map((x) => x.scriptLcp)), 'ms, style/layout/paint', med(c.map((x) => x.layoutLcp)), 'ms | total main thread', med(c.map((x) => x.busyAll)), 'ms'); }
}
await b.close();
