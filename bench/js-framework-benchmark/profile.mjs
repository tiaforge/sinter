// Script-time micro-benchmark and CPU profile of the entry in real Chrome (no paint).
//   node profile.mjs [url] — needs the benchmark server and puppeteer-core from js-framework-benchmark/webdriver-ts
import { createRequire } from 'node:module';
const require = createRequire(process.env.JFB_WEBDRIVER ?? '/home/deck/Sources/bench/js-framework-benchmark/webdriver-ts/');
const puppeteer = require('puppeteer-core');

const url = process.argv[2] ?? 'http://localhost:8080/frameworks/keyed/sinter/dist-dev/index.html';
const browser = await puppeteer.launch({ executablePath: process.env.CHROME, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto(url);
await page.waitForSelector('#run');

// time from click to the end of sinter's microtask flush
const time = (id) => page.evaluate(async (id) => {
  const t = performance.now();
  document.getElementById(id).click();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return performance.now() - t;
}, id);
const removeOne = () => page.evaluate(async () => {
  const t = performance.now();
  document.querySelector('tbody > tr:nth-of-type(4) td:nth-of-type(3) a').click();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return performance.now() - t;
});
const median = (a) => a.sort((x, y) => x - y)[a.length >> 1];
const runs = { run: [], add: [], remove: [], clear: [], runlots: [] };
for (let i = 0; i < 25; i++) {
  runs.run.push(await time('run'));
  runs.add.push(await time('add'));
  runs.remove.push(await removeOne());
  runs.clear.push(await time('clear'));
  if (i % 5 == 0) { runs.runlots.push(await time('runlots')); await time('clear'); }
}
for (const [k, v] of Object.entries(runs)) console.log(k.padEnd(8), median(v).toFixed(2), 'ms');

if (process.argv.includes('--profile')) {
  const cdp = await page.createCDPSession();
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 50 });
  await cdp.send('Profiler.start');
  for (let i = 0; i < 30; i++) { await time('run'); await removeOne(); await time('add'); await time('clear'); }
  const { profile } = await cdp.send('Profiler.stop');
  const self = new Map();
  const dt = profile.timeDeltas;
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  profile.samples.forEach((id, i) => {
    const n = byId.get(id), f = n.callFrame;
    const name = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
    self.set(name, (self.get(name) ?? 0) + (dt[i] ?? 0));
  });
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  for (const [n, t] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log((t / 1000).toFixed(1).padStart(7), 'ms', (100 * t / total).toFixed(1).padStart(5) + '%', n);
}
await browser.close();
