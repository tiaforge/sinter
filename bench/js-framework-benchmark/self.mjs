// sinter against itself (and ivi as a reference), without a js-framework-benchmark checkout: builds of
// this entry's page in headless Chrome, page loads alternating between them, each operation timed
// from click() until the render's microtasks are done and the result is laid out (offsetHeight).
// Memory: JS heap after a forced GC, ready / 1,000 rows / five create-and-clear cycles.
//
//   npm run build (repo root) && npx vite build --outDir dist-a     # one build per variant
//   npx vite build -c vite.ivi.config.js                             # dist-ivi
//   CHROME=… node self.mjs dist-a dist-b [dist-ivi] [--loads 6] [--reps 10]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values: opt, positionals: dirs } = parseArgs({ allowPositionals: true, options: { loads: { type: 'string', default: '6' }, reps: { type: 'string', default: '10' } } });
const { chromium } = await import(process.env.PLAYWRIGHT ?? '/opt/node22/lib/node_modules/playwright/index.mjs');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  try { const f = resolve(import.meta.dirname, '.' + path), body = await readFile(f); res.writeHead(200, { 'Content-Type': TYPES[extname(f)] ?? 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ['--headless=new', '--js-flags=--expose-gc', '--no-proxy-server'] });

// in the page: one operation, timed; `prep` untimed before it
const OPS = {
  'create 1k': { prep: 'clear', op: 'run' },
  'replace 1k': { prep: 'run', op: 'run' },
  'update 10th': { prep: 'run', op: 'update' },
  'select row': { prep: 'run', op: 'select' },
  'swap rows': { prep: 'run', op: 'swaprows' },
  'remove row': { prep: 'run', op: 'remove' },
  'append 1k': { prep: 'run', op: 'add' },
  'clear 1k': { prep: 'run', op: 'clear' },
  'create 10k': { prep: 'clear', op: 'runlots', reps: 3 },
};
const inPage = async ([prep, op, reps]) => {
  const drain = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const settle = async () => { await drain(); document.body.offsetHeight; };
  const press = (id) => {
    if (id === 'select') document.querySelectorAll('tbody tr')[1].querySelector('td:nth-child(2) a').click();
    else if (id === 'remove') document.querySelectorAll('tbody tr')[3].querySelector('td:nth-child(3) a').click();
    else document.getElementById(id).click();
  };
  const click = async (id) => {
    if (id === 'select') document.querySelectorAll('tbody tr')[1].querySelector('td:nth-child(2) a').click();
    else if (id === 'remove') document.querySelectorAll('tbody tr')[3].querySelector('td:nth-child(3) a').click();
    else document.getElementById(id).click();
    await settle();
  };
  const out = [];
  for (let r = 0; r < reps; r++) {
    await click('clear'); if (prep !== 'clear') await click(prep);
    await new Promise((ok) => setTimeout(ok, 20));
    const t = performance.now(); press(op); await drain(); const js = performance.now() - t; document.body.offsetHeight;
    out.push([js, performance.now() - t]);
  }
  return out;
};
const heap = async (page, cdp) => { await page.evaluate(() => gc()); const m = (await cdp.send('Performance.getMetrics')).metrics; return m.find((x) => x.name === 'JSHeapUsedSize').value / 2 ** 20; };

const times = Object.fromEntries(dirs.map((d) => [d, Object.fromEntries(Object.keys(OPS).map((k) => [k, []]))]));
const mem = Object.fromEntries(dirs.map((d) => [d, { ready: [], '1k rows': [], 'run-clear x5': [] }]));
for (let l = 0; l < +opt.loads; l++) {
  for (const d of l % 2 ? [...dirs].reverse() : dirs) {
    const page = await browser.newPage();
    const c = await page.context().newCDPSession(page); await c.send('Performance.enable');
    await page.goto(`${base}/${d}/index.html`); await page.waitForSelector('#run');
    for (const [name, o] of Object.entries(OPS)) times[d][name].push(...await page.evaluate(inPage, [o.prep, o.op, o.reps ?? +opt.reps]));
    await page.close();
    // memory in a fresh page
    const p2 = await browser.newPage(); const c2 = await p2.context().newCDPSession(p2); await c2.send('Performance.enable');
    await p2.goto(`${base}/${d}/index.html`); await p2.waitForSelector('#run');
    mem[d].ready.push(await heap(p2, c2));
    await p2.evaluate(async () => { document.getElementById('run').click(); for (let i = 0; i < 8; i++) await Promise.resolve(); });
    mem[d]['1k rows'].push(await heap(p2, c2));
    await p2.evaluate(async () => { for (let i = 0; i < 5; i++) { document.getElementById('run').click(); for (let j = 0; j < 8; j++) await Promise.resolve(); document.getElementById('clear').click(); for (let j = 0; j < 8; j++) await Promise.resolve(); } });
    mem[d]['run-clear x5'].push(await heap(p2, c2));
    await p2.close();
  }
}
await browser.close(); server.close();
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
console.log(`median ms (${opt.loads} page loads × reps): script = click → the render's microtasks done; total = also laid out (offsetHeight). Memory: MB after GC, median of loads\n`);
console.log(`| operation | ${dirs.map((d) => `${d} script | total`).join(' | ')} |\n| --- | ${dirs.map(() => '---: | ---:').join(' | ')} |`);
for (const k of Object.keys(OPS)) console.log(`| ${k} | ${dirs.map((d) => `${med(times[d][k].map((x) => x[0])).toFixed(2)} | ${med(times[d][k].map((x) => x[1])).toFixed(2)}`).join(' | ')} |`);
for (const k of ['ready', '1k rows', 'run-clear x5']) console.log(`| ${k} MB | ${dirs.map((d) => `${med(mem[d][k]).toFixed(2)} |`).join(' | ')} |`);
