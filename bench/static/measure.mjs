// Pages without JavaScript, measured: builds examples/static-site with a checkout's sinter (its `dist/`, so
// `npm run build` there first), serves the output as a static host does, and opens each page in Chromium
// (4× CPU slowdown): the scripts it downloads (gzip, level 9) and the time the main thread spent running
// script and how far the page moved as it loaded (slow 4G), and with JavaScript off, whether the page shows all of what it shows with JavaScript on.
//   node bench/static/measure.mjs [--repo <checkout>] [--label <name>]
// Writes bench/static/out/<label>/ (the build, results.json, a screenshot per page with JavaScript off).
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';
import { chromium } from 'playwright';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const here = import.meta.dirname, self = resolve(here, '../..');
const repo = resolve(arg('repo', self)), label = arg('label', 'branch');
const site = join(self, 'examples/static-site'), out = join(here, 'out', label), dist = join(out, 'dist');
const pages = ['index.html', 'about.html', 'docs/getting-started.html', 'status.html'];

// the site's vite.config.js, with the checkout's sinter
const { default: sinter } = await import(pathToFileURL(join(repo, 'dist/vite.js')).href);
const logs = [];
const log = (m) => { logs.push(m); };
await build({
  root: site, configFile: false, appType: 'mpa', logLevel: 'info',
  customLogger: { info: log, warn: log, warnOnce: log, error: log, clearScreen() {}, hasErrorLogged: () => false, hasWarned: false },
  resolve: { alias: [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: join(repo, 'dist/$1.js') }, { find: /^@tiaforge-ui\/sinter$/, replacement: join(repo, 'dist/index.js') }] },
  plugins: [sinter({ static: ['index.html', 'about.html', 'docs/**'] })],
  build: { outDir: dist, emptyOutDir: true, rollupOptions: { input: pages.map((p) => join(site, p)) } },
});

const files = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
const jsFiles = files(dist).filter((f) => f.endsWith('.js')).map((f) => relative(dist, f));

const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };
const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  // gzip, as a host serves text
  try { res.writeHead(200, { 'content-type': types[extname(path) || '.html'] ?? 'application/octet-stream', 'content-encoding': 'gzip' }).end(gzipSync(readFileSync(join(dist, path.endsWith('/') ? path + 'index.html' : path)))); }
  catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, r));
const origin = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
const rows = [];
for (const page of pages) {
  const dir = page.replace(/(^|\/)index\.html$/, '$1').replace(/\.html$/, '/');
  const url = `${origin}/${statSync(join(dist, dir, 'index.html'), { throwIfNoEntry: false }) ? dir : page}`;
  // JavaScript on: what is downloaded and run
  const on = await browser.newContext();
  const tab = await on.newPage();
  // layout shifts, as Lighthouse counts them (CLS: shifts without recent input)
  await tab.addInitScript(() => { globalThis.__cls = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) globalThis.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); });
  const cdp = await on.newCDPSession(tab);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  // slow 4G, as Lighthouse's mobile run: what arrives after the HTML shows late
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 });
  await cdp.send('Performance.enable');
  const scripts = [];
  tab.on('response', async (r) => {
    if (r.request().resourceType() !== 'script') return;
    try { const body = await r.body(); scripts.push({ url: r.url().slice(origin.length), gz: gzipSync(body, { level: 9 }).length }); } catch { /* gone */ }
  });
  await tab.goto(url, { waitUntil: 'networkidle' });
  const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const textOn = await tab.evaluate(() => document.body.innerText.trim());
  const cls = await tab.evaluate(() => globalThis.__cls);
  const timing = await tab.evaluate(() => ({ fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0, load: performance.getEntriesByType('navigation')[0].loadEventEnd }));
  await on.close();
  // JavaScript off: what a browser without scripts (or before they run) shows
  const off = await browser.newContext({ javaScriptEnabled: false });
  const tab2 = await off.newPage();
  await tab2.goto(url, { waitUntil: 'networkidle' });
  const textOff = await tab2.evaluate(() => document.body.innerText.trim());
  const navOff = await tab2.$$eval('.nav a', (a) => a.length);
  const shot = join(out, `${page.replace(/\//g, '-').replace(/\.html$/, '')}-js-off.png`);
  await tab2.screenshot({ path: shot, fullPage: true });
  await off.close();
  rows.push({
    page, scripts: scripts.length, scriptGzip: scripts.reduce((a, s) => a + s.gz, 0), scriptMs: Math.round((metrics.ScriptDuration ?? 0) * 1000), cls: Math.round(cls * 1000) / 1000, fcpMs: Math.round(timing.fcp), loadMs: Math.round(timing.load),
    navLinksWithoutJs: navOff, completeWithoutJs: textOff === textOn, textOn, textOff,
  });
}
await browser.close();
server.close();

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'results.json'), JSON.stringify({ label, repo, jsFiles, report: logs.filter((l) => l.startsWith('sinter:')), rows }, null, 2) + '\n');
console.log(`${label}: .js files in dist/: ${jsFiles.length ? jsFiles.join(', ') : 'none'}`);
for (const l of logs.filter((l) => l.startsWith('sinter:') && / JavaScript|no JavaScript/.test(l))) console.log(l);
console.log('| page | scripts | script (gzip) | script time | first paint | load | layout shift | nav links, JS off | same text, JS off |');
console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
for (const r of rows) console.log(`| ${r.page} | ${r.scripts} | ${(r.scriptGzip / 1000).toFixed(1)} kB | ${r.scriptMs} ms | ${r.fcpMs} ms | ${r.loadMs} ms | ${r.cls} | ${r.navLinksWithoutJs} | ${r.completeWithoutJs ? 'yes' : 'no'} |`);
