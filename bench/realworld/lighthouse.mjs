// Lighthouse on RealWorld implementations: each URL is audited with Lighthouse's mobile settings
// (simulated slow 4G, 4x CPU slowdown) and its desktop settings, `--runs` times; the run with the
// median performance score counts. Prints a Markdown table of the scores and the raw metrics behind
// them, and writes every report to `--out`.
//
//   CHROME=… node lighthouse.mjs [--runs 5] [--out reports] [--sinter] <name>=<url> ...
//
// --sinter also audits examples/realworld's production build (serve.mjs; build it first).
// Lighthouse simulates the network from the requests it observed (Lantern), so a page served from
// localhost and one served from a CDN are both replayed at the same simulated RTT and bandwidth;
// server response times still count as observed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import * as chromeLauncher from 'chrome-launcher';
import lighthouse, { desktopConfig } from 'lighthouse';
import { serve } from './serve.mjs';

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: { runs: { type: 'string', default: '5' }, out: { type: 'string', default: 'reports' }, sinter: { type: 'boolean' } },
});
const targets = positionals.map((a) => a.split(/=(.*)/).slice(0, 2));
const runs = Math.max(1, Number(opt.runs));
const out = resolve(opt.out);
mkdirSync(out, { recursive: true });

const server = opt.sinter ? await serve() : null;
if (server) targets.unshift(['sinter', server.url + '/']);

/** One audit in a new Chrome with a new profile: nothing cached from an earlier run or another implementation. */
async function audit(url, config) {
  const chrome = await chromeLauncher.launch({
    chromePath: process.env.CHROME || undefined,
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  try { return await lighthouse(url, { port: chrome.port, output: 'json', logLevel: 'error' }, config); } finally { await chrome.kill(); }
}

const rows = [];
try {
  for (const [form, config] of [['mobile', undefined], ['desktop', desktopConfig]]) {
    for (const [name, url] of targets) {
      const results = [];
      for (let i = 0; i < runs; i++) {
        const r = await audit(url, config);
        if (r?.lhr && !r.lhr.runtimeError) results.push(r);
        else console.error(`${name} ${form}: ${r?.lhr?.runtimeError?.message ?? 'no result'}`);
      }
      if (!results.length) { rows.push({ name, form, failed: true }); continue; }
      results.sort((a, b) => a.lhr.categories.performance.score - b.lhr.categories.performance.score);
      const { lhr, report } = results[Math.floor(results.length / 2)];
      writeFileSync(join(out, `${name}-${form}.json`), report);
      const perfs = results.map((r) => Math.round(r.lhr.categories.performance.score * 100));
      rows.push({ name, form, lhr, perfRange: `${Math.min(...perfs)}–${Math.max(...perfs)}` });
      const c = lhr.categories, a = lhr.audits;
      console.error(`${name} ${form}: perf ${Math.round(c.performance.score * 100)} (${Math.min(...perfs)}–${Math.max(...perfs)}), a11y ${Math.round(c.accessibility.score * 100)}, seo ${Math.round(c.seo.score * 100)}, LCP ${a['largest-contentful-paint'].displayValue}, CLS ${a['cumulative-layout-shift'].displayValue}`);
    }
  }
} finally {
  await server?.close();
}

const kb = (n) => (n / 1024).toFixed(1);
const ms = (n) => (n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`);
for (const form of ['mobile', 'desktop']) {
  console.log(`\n### ${form === 'mobile' ? 'Mobile (simulated slow 4G, 4x CPU slowdown)' : 'Desktop'}, median of ${runs}\n`);
  console.log('| implementation | perf | (range) | a11y | best pr. | SEO | FCP | LCP | TBT | CLS | Speed Index | JS (KB) | total (KB) | requests | main thread |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const r of rows.filter((x) => x.form === form)) {
    if (r.failed) { console.log(`| ${r.name} | failed | | | | | | | | | | | | | |`); continue; }
    const { audits: a, categories: c } = r.lhr;
    const items = a['network-requests'].details.items;
    const js = items.filter((i) => i.resourceType === 'Script').reduce((s, i) => s + i.transferSize, 0);
    const score = (id) => Math.round(c[id].score * 100);
    console.log(`| ${r.name} | ${score('performance')} | ${r.perfRange} | ${score('accessibility')} | ${score('best-practices')} | ${score('seo')} | ${ms(a['first-contentful-paint'].numericValue)} | ${ms(a['largest-contentful-paint'].numericValue)} | ${ms(a['total-blocking-time'].numericValue)} | ${a['cumulative-layout-shift'].numericValue.toFixed(3)} | ${ms(a['speed-index'].numericValue)} | ${kb(js)} | ${kb(a['total-byte-weight'].numericValue)} | ${items.length} | ${ms(a['mainthread-work-breakdown'].numericValue)} |`);
  }
}
console.log(`\nReports: ${out}`);
