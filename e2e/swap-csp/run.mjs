// sinter({ swap: true }) under a nonce Content-Security-Policy and with built-in messages, in Chromium,
// Firefox and WebKit (Playwright). The server answers each page with a fresh nonce, as a server that issues
// nonces does: on every inline <style> and <script>, in the policy it sends, and in <meta name="csp-nonce">.
// A swap runs under the first page's policy (docs/navigation.md#swaps), so the styles it inserts get the
// document's nonce; B's inline style is one. The pages' text is the app's messages (messages/*.json); in
// German the next page's own dictionary must be loaded before it mounts (B's title is a key only B has).
// Checked in each language: one page load, B's style applied, no policy violation, the messages rendered by
// the mounted page, the kept notes. Under CI a browser that does not start fails.
//   node run.mjs [chromium|firefox|webkit ...]
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = fileURLToPath(new URL('.', import.meta.url));
const pw = createRequire(join(here, '../../package.json'))('playwright');
if (spawnSync('npx', ['vite', 'build', '--logLevel', 'warn'], { cwd: here, stdio: 'inherit' }).status) process.exit(1);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  const file = path === '/' ? 'index.html' : path === '/b/' ? 'b/index.html' : normalize(path).replace(/^\/+/, '');
  let body;
  try { body = await readFile(join(here, 'dist', file)); } catch { res.writeHead(404); return res.end(); }
  if (extname(file) !== '.html') { res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }); return res.end(body); }
  const nonce = randomBytes(12).toString('base64');
  const html = String(body).replace(/<(style|script)\b/g, `<$1 nonce="${nonce}"`).replace('<head>', `<head><meta name="csp-nonce" content="${nonce}">`);
  res.writeHead(200, {
    'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; base-uri 'none'; object-src 'none'`,
  });
  res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

let failed = 0;
const browsers = process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'firefox', 'webkit'];
for (const name of browsers) {
  let browser;
  try { browser = await pw[name].launch(); } catch (e) {
    console.log(`${name}: ${process.env.CI ? '✗ did not start' : 'skipped'} (${e.message.split('\n')[0]})`);
    if (process.env.CI) failed++;
    continue;
  }
  const steps = [];
  const check = (step, got, want) => {
    const bad = Object.entries(want).filter(([k, v]) => JSON.stringify(got[k]) !== JSON.stringify(v));
    steps.push(bad.length ? `✗ ${step}: ${bad.map(([k, v]) => `${k} ${JSON.stringify(got[k])}, want ${JSON.stringify(v)}`).join('; ')}` : `✓ ${step}`);
    if (bad.length) failed++;
  };
  for (const [locale, t] of [['en', { a: 'Page A', b: 'Page B', hello: 'Hello', toA: 'To A' }], ['de', { a: 'Seite A', b: 'Seite B', hello: 'Hallo', toA: 'Zu A' }]]) {
    const page = await browser.newPage();
    const errors = [], loads = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.location().url ?? '')) errors.push(m.text()); });
    page.on('request', (r) => { if (r.isNavigationRequest() && r.frame() === page.mainFrame()) loads.push(new URL(r.url()).pathname); });
    // the language the picker chooses (the stored choice), and every policy violation the page sees
    await page.addInitScript((l) => {
      try { localStorage.setItem('locale', l); } catch { /* none */ }
      window.__violations = [];
      addEventListener('securitypolicyviolation', (e) => window.__violations.push(`${e.violatedDirective} ${e.blockedURI || e.sample || ''}`.trim()));
    }, locale);
    const read = () => page.evaluate(() => ({
      path: location.pathname, title: document.title, heading: document.getElementById('heading')?.textContent ?? null,
      toA: document.getElementById('to-a')?.textContent ?? null, notes: document.querySelector('aside textarea').value,
      color: getComputedStyle(document.getElementById('heading')).color, violations: window.__violations, marker: window.__marker ?? null,
    }));
    try {
      await page.goto(base + '/');
      await page.waitForFunction((a) => document.title === a, t.a, { timeout: 10000 }).catch(() => {});
      check(`${locale}: A loads`, await read(), { title: t.a, heading: `${t.hello} A`, toA: t.toA, violations: [] });
      await page.evaluate(() => { window.__marker = 1; });
      await page.fill('aside textarea', 'kept');
      await page.click('#to-b');
      await page.waitForFunction((b) => location.pathname === '/b/' && document.title === b, t.b, { timeout: 10000 }).catch(() => {});
      check(`${locale}: the link swaps B in, its style allowed by the stamped nonce, its messages rendered`, await read(), {
        path: '/b/', marker: 1, title: t.b, heading: `${t.hello} B`, toA: t.toA, notes: 'kept', color: 'rgb(0, 128, 0)', violations: [],
      });
      await page.goBack();
      await page.waitForFunction((a) => location.pathname === '/' && document.title === a, t.a, { timeout: 10000 }).catch(() => {});
      check(`${locale}: Back swaps A in, B's style gone`, await read(), { path: '/', marker: 1, title: t.a, heading: `${t.hello} A`, notes: 'kept', violations: [] });
      check(`${locale}: one page load`, { loads }, { loads: ['/'] });
      const color = (await read()).color;
      if (color === 'rgb(0, 128, 0)') { steps.push(`✗ ${locale}: B's style stayed on A`); failed++; }
    } catch (e) { steps.push(`✗ ${locale}: ${e.message.split('\n')[0]}`); failed++; }
    if (errors.length) { steps.push(`✗ ${locale}: errors: ${JSON.stringify(errors)}`); failed++; }
    await page.close();
  }
  console.log(`${name}:\n  ${steps.join('\n  ')}`);
  await browser.close();
}
server.close();
process.exit(failed ? 1 : 0);
