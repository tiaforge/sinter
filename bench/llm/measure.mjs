// What a solution costs its users, measured after the checks while the app is still served:
//   output   the build output on disk (dist/, build/, .svelte-kit/output/client, …), without server bundles
//   weight   what the browser downloads for each page: JS, CSS and HTML, each gzipped at level 9 here (as
//            bench/realworld/weight.mjs does, so a server's own compression does not skew it), and the request count
//   lighthouse  mobile preset, one Chrome per audit (LH_RUNS audits per page, median): scores and FCP, LCP, TBT, CLS, SI
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { chromium } from './lib.mjs';

const require = createRequire(import.meta.url);
const CHROME = process.env.CHROME ?? '/opt/pw-browsers/chromium';
const OUTPUT_DIRS = ['dist/client', 'dist', 'build/client', 'build', '.svelte-kit/output/client', 'out', '.output/public'];

function walk(dir, files = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!/^(server|node_modules)$/.test(e.name)) walk(p, files); } else files.push(p);
  }
  return files;
}

/** The build's client output: the first of OUTPUT_DIRS that exists (dist/client before dist, so Astro's server build is left out). */
export function output(dir) {
  const d = OUTPUT_DIRS.find((x) => existsSync(join(dir, x)) && statSync(join(dir, x)).isDirectory());
  if (!d) return null;
  const files = walk(join(dir, d));
  const sum = (re) => files.filter((f) => re.test(f)).reduce((n, f) => n + statSync(f).size, 0);
  return { dir: d, files: files.length, bytes: sum(/./), js: sum(/\.m?js$/), css: sum(/\.css$/), html: sum(/\.html$/) };
}

/** Bytes the browser downloads for each path. `setup(page)` runs first (sign in, route the API). */
export async function weight(baseURL, paths, { setup } = {}) {
  const browser = await chromium.launch();
  const result = {};
  for (const path of paths) {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    if (setup) await setup(page);
    // the setup (signing in) has cached the scripts: measure a load from the network, as a first visit would be
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.clearBrowserCache');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    const bodies = [];
    page.on('response', async (r) => {
      const type = r.request().resourceType();
      if (!['script', 'stylesheet', 'document'].includes(type) || !r.url().startsWith(baseURL)) return;
      bodies.push(r.body().then((b) => ({ type, gz: gzipSync(b, { level: 9 }).length })).catch(() => null));
    });
    await page.goto(path, { waitUntil: 'networkidle' }).catch(() => {});
    const rows = (await Promise.all(bodies)).filter(Boolean);
    const gz = (t) => rows.filter((x) => x.type === t).reduce((n, x) => n + x.gz, 0);
    result[path] = { jsGz: gz('script'), cssGz: gz('stylesheet'), htmlGz: gz('document'), requests: rows.length };
    await context.close();
  }
  await browser.close();
  return result;
}

/** Lighthouse, mobile, the median of LH_RUNS audits per URL. `flags`: extra Chrome flags (host mapping for a mock API). */
export async function lighthouse(urls, { flags = [], runs = Number(process.env.LH_RUNS ?? 1) } = {}) {
  const { default: lh } = await import(require.resolve('lighthouse'));
  const { launch } = await import(require.resolve('chrome-launcher'));
  const result = {};
  for (const url of urls) {
    const audits = [];
    for (let i = 0; i < runs; i++) {
      const chrome = await launch({ chromePath: CHROME, chromeFlags: ['--headless=new', '--no-sandbox', '--no-proxy-server', ...flags] });
      try {
        const r = await lh(url, { port: chrome.port, output: 'json', logLevel: 'error', onlyCategories: ['performance', 'accessibility', 'best-practices'] });
        const a = r.lhr.audits, c = r.lhr.categories;
        audits.push({
          performance: Math.round(c.performance.score * 100), accessibility: Math.round(c.accessibility.score * 100), bestPractices: Math.round(c['best-practices'].score * 100),
          fcp: a['first-contentful-paint'].numericValue, lcp: a['largest-contentful-paint'].numericValue, tbt: a['total-blocking-time'].numericValue,
          cls: a['cumulative-layout-shift'].numericValue, si: a['speed-index'].numericValue, error: r.lhr.runtimeError?.code,
        });
      } catch (e) { audits.push({ error: String(e.message ?? e).slice(0, 200) }); }
      finally { await chrome.kill(); }
    }
    const ok = audits.filter((x) => x.performance != null).sort((x, y) => x.performance - y.performance);
    result[url] = ok.length ? { ...ok[Math.floor((ok.length - 1) / 2)], runs: ok.length } : audits[0];
  }
  return result;
}

/** All three, never failing the grade: a measurement error is recorded instead. */
export async function measure({ dir, baseURL, paths, lighthousePaths = paths, setup, flags }) {
  const m = {};
  try { m.output = output(dir); } catch (e) { m.output = { error: String(e) }; }
  try { m.weight = await weight(baseURL, paths, { setup }); } catch (e) { m.weight = { error: String(e) }; }
  if (process.env.LIGHTHOUSE !== '0') {
    try { m.lighthouse = await lighthouse(lighthousePaths.map((p) => baseURL + p), { flags }); } catch (e) { m.lighthouse = { error: String(e) }; }
  }
  return m;
}
