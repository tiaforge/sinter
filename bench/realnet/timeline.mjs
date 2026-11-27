// Page-load timelines in headless Chromium, cold cache: first paint, largest paint, when an element first appears,
// performance marks, and every request's start / first byte / last byte with its protocol and priority.
// Run it inside realnet.sh's namespace for a bandwidth limit on the network path (README.md).
//
//   node bench/realnet/timeline.mjs <url> [options]
//     --runs <n>          loads (default 1); each in a new tab, the HTTP cache cleared before it (cookies kept)
//     --throttle <x>      CPU slowdown (default 4)
//     --rtt <ms>          round trip added per request by DevTools (latency only; default 0). Bandwidth is the path's.
//     --devtools-kbps <k> DevTools bandwidth emulation as well (inside the browser: it hides how the server orders
//                         its bytes, README.md); off by default
//     --data <selector>   "first data in the DOM": when an element matching it first exists
//     --marks <prefix>    performance marks to record (default: all)
//     --before <module>   runs once before the loads, in the same browser context: `export default async ({ context, origin }) => {}`
//                         (a sign-in: the cookies it gets are kept)
//     --host-map <h=a:p,…> host names resolved to an address (Chromium --host-resolver-rules), e.g. a mocked API host
//     --label <text>      stored with each load;  --json <file>  one JSON line per load appended there
//     --requests          the per-request table of the first load on stderr
//     --wait <ms>         after the load event and network idle (default 1500)
// Prints medians [min-max] on stderr; JSON lines on stdout unless --json.
import { parseArgs } from 'node:util';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const { values: o, positionals: [url] } = parseArgs({ allowPositionals: true, options: {
  runs: { type: 'string', default: '1' }, throttle: { type: 'string', default: '4' }, rtt: { type: 'string', default: '0' },
  'devtools-kbps': { type: 'string' }, data: { type: 'string' }, marks: { type: 'string', default: '' }, before: { type: 'string' },
  'host-map': { type: 'string' }, label: { type: 'string', default: '' }, json: { type: 'string' }, requests: { type: 'boolean' },
  wait: { type: 'string', default: '1500' },
} });
if (!url) { console.error('usage: node bench/realnet/timeline.mjs <url> [--runs n] [--rtt ms] [--data selector] …'); process.exit(1); }
const origin = new URL(url).origin;

// The browser must not inherit the proxy variables of the environment: Chromium would send a mocked host's
// requests to the real one (README.md, "what went wrong")
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/proxy/i.test(k)));
const args = ['--ignore-certificate-errors', '--no-proxy-server'];
if (o['host-map']) args.push(`--host-resolver-rules=${o['host-map'].split(',').map((m) => { const [h, a] = m.split('='); return `MAP ${h} ${a}`; }).join(', ')}`);
const browser = await chromium.launch({ args, env });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: true });
if (o.before) await (await import(pathToFileURL(resolve(o.before)).href)).default({ context, origin });

async function once() {
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.clearBrowserCache');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: +o.throttle });
  const kbps = o['devtools-kbps'] ? +o['devtools-kbps'] * 1000 / 8 : -1;
  if (+o.rtt || kbps > 0) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: +o.rtt, downloadThroughput: kbps, uploadThroughput: kbps });
  const net = new Map();
  cdp.on('Network.requestWillBeSent', (e) => { if (!net.has(e.request.url)) net.set(e.request.url, { priority: e.request.initialPriority, initiator: e.initiator.type }); });
  cdp.on('Network.responseReceived', (e) => { const r = net.get(e.response.url); if (r) { r.protocol = e.response.protocol; r.server = e.response.remoteIPAddress ? `${e.response.remoteIPAddress}:${e.response.remotePort}` : undefined; } });
  await page.addInitScript((sel) => {
    const t = (window.__rn = { lcp: null, data: 0 });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) t.lcp = { at: e.startTime, el: e.element ? e.element.localName + (e.element.className && typeof e.element.className == 'string' ? '.' + e.element.className.split(' ')[0] : '') : '?' }; }).observe({ type: 'largest-contentful-paint', buffered: true });
    if (sel) {
      const mo = new MutationObserver(() => { if (!t.data && document.querySelector(sel)) { t.data = performance.now(); mo.disconnect(); } });
      mo.observe(document, { childList: true, subtree: true, attributes: true });
    }
  }, o.data ?? null);
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(+o.wait);
  const t = await page.evaluate((prefix) => {
    const nav = performance.getEntriesByType('navigation')[0];
    return {
      protocol: nav.nextHopProtocol, ttfb: nav.responseStart, htmlEnd: nav.responseEnd, htmlBytes: nav.transferSize, dcl: nav.domContentLoadedEventStart,
      fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
      lcp: window.__rn.lcp?.at ?? null, lcpElement: window.__rn.lcp?.el ?? null, dataInDom: window.__rn.data || null,
      marks: Object.fromEntries(performance.getEntriesByType('mark').filter((m) => m.name.startsWith(prefix)).map((m) => [m.name, m.startTime])),
      requests: performance.getEntriesByType('resource').map((e) => ({ url: e.name, type: e.initiatorType, start: e.startTime, firstByte: e.responseStart || null, end: e.responseEnd, bytes: e.transferSize, protocol: e.nextHopProtocol || null })),
    };
  }, o.marks);
  await page.close();
  // CDP's view where resource timing is empty (another origin without Timing-Allow-Origin)
  for (const r of t.requests) { const n = net.get(r.url); if (n) { r.priority = n.priority; r.protocol ??= n.protocol ?? null; r.server = n.server; } }
  return { label: o.label, url, rtt: +o.rtt, throttle: +o.throttle, ...t };
}

const rows = [];
for (let i = 0; i < +o.runs; i++) {
  const r = await once();
  rows.push(r);
  if (o.json) appendFileSync(o.json, JSON.stringify(r) + '\n'); else console.log(JSON.stringify(r));
  if (o.requests && i === 0) {
    console.error(`  ${'start'.padStart(6)} ${'first'.padStart(6)} ${'last'.padStart(6)}  protocol  priority  bytes    request`);
    for (const q of r.requests) console.error(`  ${q.start.toFixed(0).padStart(6)} ${(q.firstByte ?? 0).toFixed(0).padStart(6)} ${q.end.toFixed(0).padStart(6)}  ${String(q.protocol).padEnd(8)}  ${String(q.priority).padEnd(8)}  ${String(q.bytes).padStart(7)}  ${q.url.length > 90 ? '…' + q.url.slice(-89) : q.url}`);
  }
}
const med = (a) => { const s = a.filter((x) => typeof x == 'number').sort((x, y) => x - y); return s.length ? `${s[s.length >> 1].toFixed(0)} [${s[0].toFixed(0)}-${s.at(-1).toFixed(0)}]` : '-'; };
const protocols = [...new Set(rows.flatMap((r) => [r.protocol, ...r.requests.map((q) => q.protocol)]).filter(Boolean))];
console.error(`${o.label || url}: ${rows.length} load(s), protocols ${protocols.join(', ')}, rtt ${o.rtt} ms (in the browser), ${o.throttle}x CPU`);
for (const [k, f] of [['first paint', (r) => r.fcp], ['largest paint', (r) => r.lcp], ['data in DOM', (r) => r.dataInDom], ['HTML end', (r) => r.htmlEnd]]) console.error(`  ${k.padEnd(14)} ${med(rows.map(f))}`);
for (const m of [...new Set(rows.flatMap((r) => Object.keys(r.marks)))]) console.error(`  ${m.padEnd(14)} ${med(rows.map((r) => r.marks[m]))}`);
console.error(`  largest element: ${[...new Set(rows.map((r) => r.lcpElement))].join(', ')}`);
await browser.close();
