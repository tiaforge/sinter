// What a RealWorld app makes the browser download: JS and CSS on the home page, then after
// opening the first article. Every file is gzipped here at level 9, so different CDN
// compression does not skew the comparison. Fonts, images and API calls are not counted.
//   CHROME=… node weight.mjs <name>=<url> ...
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';

const require = createRequire(process.env.PLAYWRIGHT_FROM ?? import.meta.url);
const { chromium } = require('@playwright/test');

const browser = await chromium.launch({ executablePath: process.env.CHROME });
const rows = [];
for (const arg of process.argv.slice(2)) {
  const [name, url] = arg.split(/=(.*)/);
  const page = await browser.newPage();
  const seen = new Map();
  page.on('response', async (res) => {
    const type = res.request().resourceType();
    if ((type !== 'script' && type !== 'stylesheet') || seen.has(res.url())) return;
    seen.set(res.url(), null);
    try {
      const body = await res.body();
      seen.set(res.url(), { type, raw: body.length, gz: gzipSync(body, { level: 9 }).length, phase });
    } catch { seen.delete(res.url()); }
  });
  let phase = 'home', note = '';
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForSelector('.article-preview a.preview-link, .article-preview h1', { timeout: 15000 });
    phase = 'article';
    await Promise.all([page.waitForLoadState('networkidle'), page.locator('.article-preview a.preview-link, .article-preview h1').first().click()]);
    await page.waitForSelector('.article-page, .article-content', { timeout: 15000 });
    await page.waitForLoadState('networkidle');
  } catch (e) {
    // no article reachable (e.g. the demo's backend is gone): report what the home page loaded
    if (phase == 'home') await page.waitForLoadState('networkidle').catch(() => {});
    note = phase == 'home' ? 'no articles shown' : 'article did not open';
  }
  const files = [...seen.values()].filter(Boolean);
  const sum = (f) => files.filter(f).reduce((a, x) => a + x.gz, 0);
  rows.push({
    name,
    homeJs: sum((x) => x.type == 'script' && x.phase == 'home'),
    articleJs: sum((x) => x.type == 'script'),
    css: sum((x) => x.type == 'stylesheet'),
    rawJs: files.filter((x) => x.type == 'script').reduce((a, x) => a + x.raw, 0),
    files: files.length,
    note,
  });
  await page.close();
}
await browser.close();
const kb = (n) => (n / 1024).toFixed(1);
console.log('| implementation | JS, home (gz KB) | JS, home + article (gz KB) | JS, home + article (raw KB) | CSS (gz KB) | note |');
console.log('| --- | ---: | ---: | ---: | ---: | --- |');
for (const r of rows) console.log(`| ${r.name} | ${kb(r.homeJs)} | ${r.note ? '' : kb(r.articleJs)} | ${kb(r.rawJs)} | ${kb(r.css)} | ${r.note} |`);
