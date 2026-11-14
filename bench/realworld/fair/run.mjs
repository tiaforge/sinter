// Lighthouse on every RealWorld implementation under the same conditions (world.mjs): the same local API, the same
// recorded third-party files, the same static server; each audit in a new Chrome with an empty profile.
//   CHROME=/path/to/chrome node run.mjs [--work dir] [--runs 5] [--delay 150] [--record] [--only a,b] [--out dir]
// --record: first one load per app and form factor that fetches missing third-party files once (setup's first run
//   needs it); without it a file that was not recorded is a 404, and the run says so.
// Runs are interleaved (run i of every app, then run i+1), so a slow minute on the machine hits every app alike.
// An audit whose page had a failed request, or (for a client-rendered app) no article list request, is reported.
// Writes <out>/results.md (the tables), <out>/results.json (every run, versions), <out>/<app>-<form>.json (median reports).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import * as chromeLauncher from 'chrome-launcher';
import lighthouse, { desktopConfig } from 'lighthouse';
import { apps } from './apps.mjs';
import { IMPLEMENTATIONS } from './implementations.mjs';
import { world } from './world.mjs';

const { values: opt } = parseArgs({ options: {
  work: { type: 'string', default: join(import.meta.dirname, 'work') }, runs: { type: 'string', default: '5' }, delay: { type: 'string', default: '150' },
  record: { type: 'boolean' }, only: { type: 'string' }, out: { type: 'string' },
} });
const work = resolve(opt.work), runs = Number(opt.runs), delay = Number(opt.delay);
const out = resolve(opt.out ?? join(work, `results-${new Date().toISOString().slice(0, 16).replace(/:/g, '')}`));
mkdirSync(out, { recursive: true });
const CHROME = process.env.CHROME || undefined;
const versionOf = (pkg) => JSON.parse(readFileSync(createRequire(import.meta.url).resolve(`${pkg}/package.json`), 'utf8')).version;
const chromeVersion = (() => { try { return execFileSync(CHROME ?? chromeLauncher.Launcher.getInstallations()[0], ['--version'], { encoding: 'utf8' }).trim(); } catch { return null; } })();

const w = await world({ dir: work, delay, record: !!opt.record });
const APPS = apps(work, w);
const names = opt.only ? opt.only.split(',') : Object.keys(APPS);
const serverSide = new Set(IMPLEMENTATIONS.filter((i) => i.server).map((i) => i.name));

async function audit(url, config) {
  const chrome = await chromeLauncher.launch({ chromePath: CHROME, chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', ...w.flags] });
  try { return await lighthouse(url, { port: chrome.port, output: 'json', logLevel: 'error' }, config); } finally { await chrome.kill(); }
}

const rows = [], all = [];
try {
  const servers = {};
  for (const n of names) servers[n] = await APPS[n]();
  if (opt.record) {
    for (const n of names) for (const c of [undefined, desktopConfig]) { const r = await audit(servers[n].url, c); console.error(`warm-up ${n}: ${r?.lhr?.runtimeError?.message ?? 'ok'}`); }
    console.error(`still missing after the warm-up: ${[...w.misses].join(' ') || 'none'}`);
    w.misses.clear();
  }
  for (const [form, config] of [['mobile', undefined], ['desktop', desktopConfig]]) {
    const results = Object.fromEntries(names.map((n) => [n, []]));
    for (let run = 0; run < runs; run++) for (const n of names) {
      const r = await audit(servers[n].url, config);
      if (!r?.lhr || r.lhr.runtimeError) { console.error(`${n} ${form} run ${run + 1}: ${r?.lhr?.runtimeError?.message ?? 'no result'}`); continue; }
      const a = r.lhr.audits, items = a['network-requests'].details.items;
      const bad = items.filter((x) => !x.finished || x.statusCode >= 400 || x.statusCode <= 0).map((x) => `${x.statusCode} ${x.url}`);
      const api = serverSide.has(n) || items.some((x) => /api\.realworld\.show\/api\/articles\?/.test(x.url) && x.statusCode === 200);
      if (bad.length || !api) console.error(`${n} ${form} run ${run + 1}: ${bad.length} failed requests ${bad.join(' ')}${api ? '' : '; no article list request'}`);
      const metrics = { perf: Math.round(r.lhr.categories.performance.score * 100), fcp: a['first-contentful-paint'].numericValue, lcp: a['largest-contentful-paint'].numericValue, tbt: a['total-blocking-time'].numericValue, cls: a['cumulative-layout-shift'].numericValue, si: a['speed-index'].numericValue };
      all.push({ app: n, form, run: run + 1, ...metrics, failed: bad });
      results[n].push({ r, bad });
    }
    for (const n of names) {
      const rs = results[n].sort((x, y) => x.r.lhr.categories.performance.score - y.r.lhr.categories.performance.score);
      if (!rs.length) { rows.push({ n, form, failed: true }); continue; }
      const { r: { lhr, report } } = rs[Math.floor(rs.length / 2)];
      writeFileSync(join(out, `${n.replace(/\W+/g, '-').replace(/-$/, '')}-${form}.json`), report);
      const perfs = rs.map((x) => Math.round(x.r.lhr.categories.performance.score * 100));
      rows.push({ n, form, lhr, bad: rs.reduce((t, x) => t + x.bad.length, 0), range: `${Math.min(...perfs)}–${Math.max(...perfs)}`, all: perfs.join(', ') });
      console.error(`${n} ${form}: perf ${Math.round(lhr.categories.performance.score * 100)} (${Math.min(...perfs)}–${Math.max(...perfs)})`);
    }
  }
  for (const s of Object.values(servers)) await s.close();
} finally { await w.close(); }
if (w.misses.size) console.error(`missing during the audits: ${[...w.misses].join(' ')}`);

const kb = (n) => (n / 1024).toFixed(1), ms = (n) => (n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`);
const md = [];
for (const form of ['mobile', 'desktop']) {
  md.push(`\n### ${form === 'mobile' ? 'Mobile (simulated slow 4G, 4x CPU slowdown)' : 'Desktop'}: median of ${runs}, API ${delay} ms\n`);
  md.push('| implementation | perf | range | all runs | FCP | LCP | TBT | CLS | Speed Index | JS (KB) | requests | failed requests |');
  md.push('| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const r of rows.filter((x) => x.form === form).sort((x, y) => (y.lhr?.categories.performance.score ?? -1) - (x.lhr?.categories.performance.score ?? -1))) {
    if (r.failed) { md.push(`| ${r.n} | failed | | | | | | | | | | |`); continue; }
    const a = r.lhr.audits, items = a['network-requests'].details.items;
    const js = items.filter((i) => i.resourceType === 'Script').reduce((s, i) => s + i.transferSize, 0);
    md.push(`| ${r.n} | ${Math.round(r.lhr.categories.performance.score * 100)} | ${r.range} | ${r.all} | ${ms(a['first-contentful-paint'].numericValue)} | ${ms(a['largest-contentful-paint'].numericValue)} | ${ms(a['total-blocking-time'].numericValue)} | ${a['cumulative-layout-shift'].numericValue.toFixed(3)} | ${ms(a['speed-index'].numericValue)} | ${kb(js)} | ${items.length} | ${r.bad} |`);
  }
}
const versionsFile = join(work, 'versions.json');
const meta = {
  date: new Date().toISOString(), runsPerApp: runs, apiDelayMs: delay, chrome: chromeVersion, lighthouse: versionOf('lighthouse'), chromeLauncher: versionOf('chrome-launcher'),
  fixtures: w.fixtures(), misses: [...w.misses], builds: existsSync(versionsFile) ? JSON.parse(readFileSync(versionsFile, 'utf8')) : null,
};
md.push(`\n${meta.chrome}, Lighthouse ${meta.lighthouse}; fixtures ${meta.fixtures}; builds: ${versionsFile}`);
writeFileSync(join(out, 'results.md'), md.join('\n') + '\n');
writeFileSync(join(out, 'results.json'), JSON.stringify({ ...meta, audits: all }, null, 2) + '\n');
console.log(md.join('\n'));
console.log(`\nReports: ${out}`);
