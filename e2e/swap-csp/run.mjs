// sinter({ swap: true }) under a nonce Content-Security-Policy and with built-in messages, in Chromium,
// Firefox and WebKit (Playwright). The server answers each page with a fresh nonce, as a server that issues
// nonces does: on every inline <style> and <script>, in the policy it sends, and in <meta name="csp-nonce">.
// A swap runs under the first page's policy (docs/navigation.md#swaps), so the styles it inserts get the
// document's nonce; B's inline style is one. The pages' text is the app's messages (messages/*.json); in
// German the next page's own dictionary must be loaded before it mounts (B's title is a key only B has).
// Checked in each language: one page load, B's style applied, no policy violation but the injected markup's
// (B has a style and a module script with a guessed nonce, blocked on a load: a swap must block them too, under
// 'strict-dynamic'), the messages rendered by the mounted page, the kept notes. Under CI a browser that does
// not start fails.
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
let nometa = false;
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  // `/control/nometa`: the next answer for B names no nonce (another template) and has a module script without
  // one injected: the swap cannot trust anything in it, B is loaded (and the policy blocks the script)
  if (path === '/control/nometa') { nometa = true; res.writeHead(204); return res.end(); }
  // what an injection would run: it must not, on a load or a swap
  if (path === '/evil.js') { res.writeHead(200, { 'Content-Type': TYPES['.js'] }); return res.end('window.__evil = 1;'); }
  const file = path === '/' ? 'index.html' : path === '/b/' ? 'b/index.html' : normalize(path).replace(/^\/+/, '');
  let body;
  try { body = await readFile(join(here, 'dist', file)); } catch { res.writeHead(404); return res.end(); }
  if (extname(file) !== '.html') { res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }); return res.end(body); }
  const nonce = randomBytes(12).toString('base64');
  // the server's own styles and scripts get the nonce; B also has markup injected with a guessed one (a stored
  // XSS), which the policy blocks on a load and a swap must block too
  let html = String(body).replace(/<(style|script)\b(?![^>]*\snonce=)/g, `<$1 nonce="${nonce}"`).replace('<head>', `<head><meta name="csp-nonce" content="${nonce}">`);
  if (file === 'b/index.html' && nometa) {
    nometa = false;
    html = String(body).replace(/<(style|script)\b(?![^>]*\snonce=)/g, `<$1 nonce="${nonce}"`).replace('</main>', '<script type="module" src="/evil.js"></script></main>');
  } else if (file === 'b/index.html') html = html.replace('</main>', '<style nonce="guess">#heading { text-decoration-line: underline; }</style><script type="module" nonce="guess" src="/evil.js"></script></main>');
  res.writeHead(200, {
    'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store',
    // 'strict-dynamic': a script runs by its nonce (or because a trusted script loads it), not by its origin
    'Content-Security-Policy': `default-src 'self'; script-src 'nonce-${nonce}' 'strict-dynamic'; style-src 'self' 'nonce-${nonce}'; base-uri 'none'; object-src 'none'`,
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
    // (the browsers' notices of the injected style and script being blocked: the policy's, checked below)
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.location().url ?? '') && !/Content.Security.Policy|Refused to (apply|load|execute)/.test(m.text())) errors.push(m.text()); });
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
      injected: { style: getComputedStyle(document.getElementById('heading')).textDecorationLine === 'underline', script: !!window.__evil },
      lang: document.documentElement.lang,
    }));
    try {
      await page.goto(base + '/');
      await page.waitForFunction((a) => document.title === a, t.a, { timeout: 10000 }).catch(() => {});
      check(`${locale}: A loads`, await read(), { title: t.a, heading: `${t.hello} A`, toA: t.toA, violations: [] });
      await page.evaluate(() => { window.__marker = 1; });
      await page.fill('aside textarea', 'kept');
      await page.click('#to-b');
      await page.waitForFunction((b) => location.pathname === '/b/' && document.title === b, t.b, { timeout: 10000 }).catch(() => {});
      // (the injected style and script are blocked: their violations are the policy's, as on a load of B)
      const b = await read();
      check(`${locale}: the link swaps B in, its style allowed by the server's nonce, its messages rendered, the injected style and script blocked`, { ...b, violations: b.violations.filter((v) => !/^(style-src-elem|script-src-elem)\b/.test(v)) }, {
        path: '/b/', marker: 1, title: t.b, heading: `${t.hello} B`, toA: t.toA, notes: 'kept', color: 'rgb(0, 128, 0)', violations: [], injected: { style: false, script: false }, lang: locale,
      });
      await page.goBack();
      await page.waitForFunction((a) => location.pathname === '/' && document.title === a, t.a, { timeout: 10000 }).catch(() => {});
      const a = await read();
      check(`${locale}: Back swaps A in, B's style gone`, { ...a, violations: a.violations.filter((v) => !/^(style-src-elem|script-src-elem)\b/.test(v)) }, { path: '/', marker: 1, title: t.a, heading: `${t.hello} A`, notes: 'kept', violations: [] });
      check(`${locale}: one page load`, { loads }, { loads: ['/'] });
      // a next page that names no nonce of its own: nothing in it is trusted, it is loaded (the script blocked)
      await fetch(base + '/control/nometa');
      await page.click('#to-b');
      await page.waitForFunction((b) => location.pathname === '/b/' && document.title === b, t.b, { timeout: 10000 }).catch(() => {});
      const nm = await read();
      check(`${locale}: a page without its own nonce is loaded, its injected script not run`, { path: nm.path, marker: nm.marker, script: nm.injected.script }, { path: '/b/', marker: null, script: false });
      await page.goto(base + '/');
      await page.waitForFunction((a) => document.title === a, t.a, { timeout: 10000 }).catch(() => {});
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
