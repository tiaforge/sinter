// takeover: how many of the elements the early script rendered the page module keeps (embedded data)
import { chromium } from 'playwright';
const b = await chromium.launch(), out = {};
for (const pg of ['article', 'tree', 'comments']) {
  const p = await b.newPage();
  await p.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
    const els = [...document.querySelectorAll('main *:not(template)')];
    els.forEach((e) => { e.__early = 1; });
    window.__early = els.length;
  }));
  await p.goto(`http://127.0.0.1:4391/${pg}/`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(800);
  out[pg] = await p.evaluate(() => ({ early: window.__early, now: document.querySelectorAll('main *:not(template)').length, kept: [...document.querySelectorAll('main *:not(template)')].filter((x) => x.__early).length }));
  await p.close();
}
await b.close();
console.log(JSON.stringify(out));
