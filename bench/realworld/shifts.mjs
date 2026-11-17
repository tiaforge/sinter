// Which elements move, per Lighthouse run: each run's CLS and its layout shifts (Lighthouse's
// `layout-shifts` audit: the shift's score and the nodes that moved). For an intermittent CLS, to tell
// a good run from a bad one by what moved.
//
//   node shifts.mjs --dist <dir> [--axum] [--page /article/article-25] [--warm] [--runs 5] [--form mobile]
import { parseArgs } from 'node:util';
import * as chromeLauncher from 'chrome-launcher';
import lighthouse, { desktopConfig } from 'lighthouse';
import { serveAxum } from './axum.mjs';
import { mockApi } from './mock-api.mjs';
import { serve } from './serve.mjs';

const { values: opt } = parseArgs({ options: {
  dist: { type: 'string' }, axum: { type: 'boolean' }, page: { type: 'string', default: '/article/article-25' },
  warm: { type: 'boolean' }, runs: { type: 'string', default: '5' }, form: { type: 'string', default: 'mobile' },
} });
const api = await mockApi();
const server = opt.axum ? await serveAxum({ dist: opt.dist, api: api.http }) : await serve({ dist: opt.dist });
const config = opt.form === 'desktop' ? desktopConfig : undefined;
try {
  for (let i = 0; i < Number(opt.runs); i++) {
    const chrome = await chromeLauncher.launch({
      chromePath: process.env.CHROME || undefined,
      chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', ...api.flags],
    });
    let lhr;
    try {
      const urls = opt.warm ? [server.url + '/', server.url + opt.page] : [server.url + opt.page];
      for (const [j, url] of urls.entries()) lhr = (await lighthouse(url, { port: chrome.port, output: 'json', logLevel: 'error', disableStorageReset: j > 0 }, config)).lhr;
    } finally { await chrome.kill(); }
    const a = lhr.audits, items = a['layout-shifts']?.details?.items ?? [];
    console.log(`run ${i + 1}: CLS ${a['cumulative-layout-shift'].numericValue.toFixed(3)}, LCP ${Math.round(a['largest-contentful-paint'].numericValue)} ms`);
    for (const s of items) {
      console.log(`  shift ${s.score.toFixed(3)}${s.subItems ? ' causes: ' + s.subItems.items.map((c) => c.extra?.value ?? c.cause).join('; ') : ''}`);
      console.log(`    ${s.node?.selector ?? ''} ${s.node?.snippet?.slice(0, 160) ?? ''}`);
    }
  }
} finally { await server.close(); await api.close(); }
