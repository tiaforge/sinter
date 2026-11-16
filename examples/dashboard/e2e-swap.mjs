// The dashboard with swaps on, in Chromium, Firefox and WebKit (Playwright): the build served by
// `vite preview` (with the demo API), then in each browser: the player plays, notes are typed, the header's
// link swaps the latency page in and Back swaps the overview in again. Checked: one page load, the sound
// playing on (not paused, its time still advancing), the notes and the drawer kept, each page's data, and
// one event stream open at a time (the old page's closes). Under CI a browser that does not start fails.
//   npx vite build && node e2e-swap.mjs [chromium|firefox|webkit ...]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const pw = createRequire(new URL('../../package.json', import.meta.url))('playwright');
const port = 4317;
const server = spawn('./node_modules/.bin/vite', ['preview', '--port', String(port), '--strictPort'], { cwd: here, stdio: ['ignore', 'pipe', 'inherit'] });
const base = `http://localhost:${port}`;
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(base + '/')).ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 250));
}

let failed = 0;
const browsers = process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'firefox', 'webkit'];
for (const name of browsers) {
  let browser;
  try {
    browser = await pw[name].launch(name === 'chromium' ? { args: ['--autoplay-policy=no-user-gesture-required'] } : name === 'firefox' ? { firefoxUserPrefs: { 'media.autoplay.default': 0 } } : {});
  } catch (e) {
    console.log(`${name}: ${process.env.CI ? '✗ did not start' : 'skipped'} (${e.message.split('\n')[0]})`);
    if (process.env.CI) failed++;
    continue;
  }
  const page = await browser.newPage();
  const errors = [], loads = [], steps = [];
  page.on('pageerror', (e) => errors.push(process.env.STACK ? e.stack : e.message));
  page.on('request', (r) => { if (r.isNavigationRequest() && r.frame() === page.mainFrame()) loads.push(new URL(r.url()).pathname); });
  // each event stream the page opens, and whether it is still open
  await page.addInitScript(() => {
    const ES = window.EventSource;
    window.__streams = [];
    window.EventSource = class extends ES {
      constructor(...a) { super(...a); window.__streams.push(this); }
    };
  });
  const check = (step, got, want) => {
    const bad = Object.entries(want).filter(([k, v]) => JSON.stringify(got[k]) !== JSON.stringify(v));
    steps.push(bad.length ? `✗ ${step}: ${bad.map(([k, v]) => `${k} ${JSON.stringify(got[k])}, want ${JSON.stringify(v)}`).join('; ')}` : `✓ ${step}`);
    if (bad.length) failed++;
  };
  const read = () => page.evaluate(async () => {
    const a = document.querySelector('.dock audio'), t = a.currentTime;
    await new Promise((r) => setTimeout(r, 400));
    return {
      path: location.pathname, heading: document.querySelector('main h1')?.textContent ?? null, kept: window.__dock === document.querySelector('.dock'),
      open: document.querySelector('.dock').open, notes: document.querySelector('.dock textarea').value,
      playing: !a.paused && a.currentTime > t, rows: document.querySelectorAll('main tbody tr').length,
      streams: window.__streams.filter((s) => s.readyState !== 2).length,
    };
  });
  try {
    await page.goto(base + '/');
    await page.waitForFunction(() => window.__streams.some((s) => s.readyState === 1), null, { timeout: 10000 });
    await page.evaluate(() => { window.__dock = document.querySelector('.dock'); window.__dock.open = true; });
    await page.fill('.dock textarea', 'watch the p99');
    await page.evaluate(() => document.querySelector('.dock audio').play());
    await page.waitForTimeout(500);
    await page.click('header a[href="/latency/"]');
    await page.waitForFunction(() => location.pathname === '/latency/' && document.querySelectorAll('main tbody tr').length > 0, null, { timeout: 10000 }).catch(() => {});
    check('the link swaps the latency page in; the player plays on', await read(), { path: '/latency/', heading: 'Latency', kept: true, open: true, notes: 'watch the p99', playing: true, streams: 1 });
    await page.goBack();
    await page.waitForFunction(() => location.pathname === '/' && !document.querySelector('main tbody tr'), null, { timeout: 10000 }).catch(() => {});
    check('Back swaps the overview in', await read(), { path: '/', kept: true, open: true, notes: 'watch the p99', playing: true, streams: 1 });
    check('one page load', { loads }, { loads: ['/'] });
  } catch (e) { steps.push(`✗ ${e.message.split('\n')[0]}`); failed++; }
  if (errors.length) { steps.push(`✗ errors: ${JSON.stringify(errors)}`); failed++; }
  console.log(`${name}:\n  ${steps.join('\n  ')}`);
  await browser.close();
}
server.kill();
process.exit(failed ? 1 : 0);
