// A/B of two production builds of examples/realworld with Lighthouse, against a fixed local API
// (mock-api.mjs), so only the builds differ. Runs alternate between A and B (machine drift hits
// both alike); each audit gets a new Chrome and profile. Prints the median of each metric.
//
//   node ab.mjs --a dist-a --b dist-b [--runs 7] [--pages /,/article/article-25] [--warm]
//
// `--warm`: also each page opened after the index page in the same profile, cache kept (the
// index's audit is discarded): what a reader following a link downloads.
import { parseArgs } from 'node:util';
import * as chromeLauncher from 'chrome-launcher';
import lighthouse, { desktopConfig } from 'lighthouse';
import { mockApi } from './mock-api.mjs';
import { serve } from './serve.mjs';

const { values: opt } = parseArgs({ options: {
  a: { type: 'string' }, b: { type: 'string' }, runs: { type: 'string', default: '7' },
  pages: { type: 'string', default: '/,/article/article-25,/profile/author1,/login' }, warm: { type: 'boolean' },
} });
const runs = Number(opt.runs), pages = opt.pages.split(',');
const api = await mockApi();
const servers = { A: await serve({ dist: opt.a }), B: await serve({ dist: opt.b }) };

async function audit(urls, config) {
  const chrome = await chromeLauncher.launch({
    chromePath: process.env.CHROME || undefined,
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', ...api.flags],
  });
  try {
    let r;
    for (const [i, url] of urls.entries()) r = await lighthouse(url, { port: chrome.port, output: 'json', logLevel: 'error', disableStorageReset: i > 0 }, config);
    return r.lhr;
  } finally { await chrome.kill(); }
}

const metric = (lhr) => {
  const a = lhr.audits, items = a['network-requests'].details.items, js = items.filter((i) => i.resourceType === 'Script');
  return {
    perf: lhr.categories.performance.score * 100, fcp: a['first-contentful-paint'].numericValue, lcp: a['largest-contentful-paint'].numericValue,
    si: a['speed-index'].numericValue, tbt: a['total-blocking-time'].numericValue,
    js: js.reduce((s, i) => s + i.transferSize, 0) / 1024, jsReq: js.length, req: items.length,
  };
};
const median = (xs) => { const s = [...xs].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

const cases = [];
for (const [form, config] of [['mobile', undefined], ['desktop', desktopConfig]]) {
  for (const page of pages) {
    cases.push({ form, config, page, warm: false });
    if (opt.warm && page !== '/') cases.push({ form, config, page, warm: true });
  }
}
const rows = [];
try {
  for (const c of cases) {
    const got = { A: [], B: [] };
    for (let i = 0; i < runs; i++) for (const v of i % 2 ? ['B', 'A'] : ['A', 'B']) {
      const base = servers[v].url, lhr = await audit(c.warm ? [base + '/', base + c.page] : [base + c.page], c.config);
      if (lhr.runtimeError) { console.error(`${v} ${c.form} ${c.page}: ${lhr.runtimeError.message}`); continue; }
      got[v].push(metric(lhr));
    }
    const med = (v) => Object.fromEntries(Object.keys(got[v][0]).map((k) => [k, median(got[v].map((m) => m[k]))]));
    const row = { ...c, A: med('A'), B: med('B') };
    rows.push(row);
    console.error(`${c.form} ${c.page}${c.warm ? ' (after /)' : ''}: LCP ${Math.round(row.A.lcp)} → ${Math.round(row.B.lcp)} ms, FCP ${Math.round(row.A.fcp)} → ${Math.round(row.B.fcp)} ms`);
  }
} finally {
  await servers.A.close(); await servers.B.close(); await api.close();
}

const ms = (n) => `${Math.round(n)}`;
console.log(`\nMedian of ${runs} runs each; A = ${opt.a}, B = ${opt.b}. Times in ms, JS transferred in KB (brotli).\n`);
console.log('| form | page | perf A/B | FCP A | FCP B | LCP A | LCP B | SI A | SI B | TBT A | TBT B | JS A | JS B | JS req A/B | req A/B |');
console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const r of rows) {
  console.log(`| ${r.form} | ${r.page}${r.warm ? ' (after /)' : ''} | ${Math.round(r.A.perf)}/${Math.round(r.B.perf)} | ${ms(r.A.fcp)} | ${ms(r.B.fcp)} | ${ms(r.A.lcp)} | ${ms(r.B.lcp)} | ${ms(r.A.si)} | ${ms(r.B.si)} | ${ms(r.A.tbt)} | ${ms(r.B.tbt)} | ${r.A.js.toFixed(1)} | ${r.B.js.toFixed(1)} | ${r.A.jsReq}/${r.B.jsReq} | ${r.A.req}/${r.B.req} |`);
}
