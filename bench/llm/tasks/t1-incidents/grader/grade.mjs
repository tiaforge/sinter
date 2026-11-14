// Hidden checks for T1. Usage: node grade.mjs <workspace> → JSON on stdout.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, buildAndServe, runChecks, start, waitForUrl } from '../../../lib.mjs';

const dir = process.argv[2];
const PORT = Number(process.env.PREVIEW_PORT ?? 4400), API_PORT = process.env.API_PORT ?? '3001', API = `http://localhost:${API_PORT}`;
const apiServer = join(fileURLToPath(new URL('.', import.meta.url)), '../workspace/api/server.mjs');
const api = start('node', [apiServer], { env: { PORT: API_PORT, WRITE_DELAY_MS: '1500' } });
await waitForUrl(`${API}/api/incidents`);
const reset = () => fetch(`${API}/__reset`, { method: 'POST' });

const app = await buildAndServe(dir, PORT);
const out = { build: app.build.code === 0, served: app.ok, checks: [], buildLog: app.ok ? undefined : (app.install.out + app.build.out).slice(-3000) };

const items = (page) => page.getByTestId('incident');
const row = (page, text) => items(page).filter({ hasText: text });
const expectCount = async (loc, n, ms = 5000) => {
  const end = Date.now() + ms; let c;
  while (Date.now() < end) { c = await loc.count(); if (c === n) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error(`expected ${n}, got ${c}`);
};
const expectText = async (loc, re, ms = 5000) => {
  const end = Date.now() + ms; let t = '';
  while (Date.now() < end) { t = (await loc.textContent().catch(() => '')) ?? ''; if (re.test(t)) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error(`expected ${re}, got "${t.trim().slice(0, 80)}"`);
};

const checks = {
  'list: all incidents, newest first': async (page) => {
    await page.goto('/');
    await expectCount(items(page), 5);
    const first = await items(page).first().textContent();
    assert(first.includes('Password reset email delayed'), `first is "${first.trim().slice(0, 60)}"`);
  },
  'list: severity and status per item': async (page) => {
    await page.goto('/');
    const r = row(page, 'Checkout returns 502');
    await expectText(r.getByTestId('severity'), /^\s*high\s*$/i);
    await expectText(r.getByTestId('status'), /^\s*open\s*$/i);
    await expectText(row(page, 'Typo on the pricing').getByTestId('status'), /^\s*resolved\s*$/i);
  },
  'list: count': async (page) => {
    await page.goto('/');
    await expectText(page.getByTestId('count'), /\b5 incidents\b/);
  },
  'list: shows current data on each load': async (page) => {
    await page.goto('/');
    await expectCount(items(page), 5);
    await fetch(`${API}/api/incidents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Created by someone else', severity: 'low' }) });
    await page.reload();
    await expectCount(row(page, 'Created by someone else'), 1);
  },
  'list: title links to detail page': async (page) => {
    await page.goto('/');
    await row(page, 'Search results load slowly').getByRole('link', { name: /Search results load slowly/ }).click();
    await page.waitForURL(/\/incidents\/2\/?$/);
    await expectText(page.locator('h1'), /Search results load slowly/);
  },
  'search: filters as you type, ignoring case': async (page) => {
    await page.goto('/');
    await expectCount(items(page), 5);
    await page.getByTestId('search').pressSequentially('PASSWORD', { delay: 30 });
    await expectCount(items(page), 1);
    await expectText(page.getByTestId('count'), /\b1 incidents?\b/);
  },
  'filter: open, in the URL': async (page) => {
    await page.goto('/');
    await expectCount(items(page), 5);
    await page.getByTestId('filter-open').click();
    await page.waitForURL(/[?&]status=open/);
    await expectCount(items(page), 3);
    await page.reload();
    await expectCount(items(page), 3);
  },
  'filter: resolved from a shared link, back to all': async (page) => {
    await page.goto('/?status=resolved');
    await expectCount(items(page), 2);
    await page.getByTestId('filter-all').click();
    await expectCount(items(page), 5);
    assert(!/status=/.test(page.url()), `url still has status: ${page.url()}`);
  },
  'create: appears at the top without a reload, field cleared': async (page) => {
    await page.goto('/');
    await expectCount(items(page), 5);
    await page.evaluate(() => { window.__marker = 1; });
    const form = page.getByTestId('create');
    await form.locator('[name=title]').fill('Pager went off at 3am');
    await form.locator('select[name=severity]').selectOption('high');
    await form.locator('button[type=submit], input[type=submit], button:not([type])').first().click();
    await expectCount(items(page), 6, 6000);
    await expectText(items(page).first(), /Pager went off at 3am/);
    assert(await page.evaluate(() => window.__marker === 1), 'the page reloaded');
    assert((await form.locator('[name=title]').inputValue()) === '', 'title not cleared');
    const r = await (await fetch(`${API}/api/incidents`)).json();
    assert(r.incidents.some((i) => i.title === 'Pager went off at 3am' && i.severity === 'high'), 'not saved with severity high');
  },
  'create: 422 shows the field message and keeps input': async (page) => {
    await page.goto('/');
    await expectCount(items(page), 5);
    const form = page.getByTestId('create');
    const long = 'x'.repeat(81);
    await form.locator('[name=title]').fill(long);
    await form.locator('button[type=submit], input[type=submit], button:not([type])').first().click();
    await expectText(page.getByTestId('error').first(), /at most 80 characters/, 6000);
    assert((await form.locator('[name=title]').inputValue()) === long, 'input not kept');
    await expectCount(items(page), 5);
  },
  'resolve: optimistic (before the slow server answers)': async (page) => {
    await page.goto('/');
    const r = row(page, 'Checkout returns 502');
    await r.getByTestId('resolve').click();
    await expectText(r.getByTestId('status'), /^\s*resolved\s*$/i, 700); // the server takes 1.5 s
    await new Promise((ok) => setTimeout(ok, 2000));
    const api = await (await fetch(`${API}/api/incidents/1`)).json();
    assert(api.incident.status === 'resolved', 'not saved');
    await expectText(r.getByTestId('status'), /^\s*resolved\s*$/i);
  },
  'resolve: rolls back and explains on failure': async (page) => {
    await page.goto('/');
    const r = row(page, '[locked] Database failover drill');
    await r.getByTestId('resolve').click();
    await expectText(page.getByTestId('error').first(), /\S/, 4000);
    await expectText(r.getByTestId('status'), /^\s*open\s*$/i, 3000);
  },
  'reopen: a resolved incident': async (page) => {
    await page.goto('/');
    const r = row(page, 'Typo on the pricing');
    await r.getByTestId('reopen').click();
    await expectText(r.getByTestId('status'), /^\s*open\s*$/i, 3000);
    await new Promise((ok) => setTimeout(ok, 2000));
    assert((await (await fetch(`${API}/api/incidents/3`)).json()).incident.status === 'open', 'not saved');
  },
  'delete: removes from list and server': async (page) => {
    await page.goto('/');
    await expectCount(items(page), 5);
    page.on('dialog', (d) => d.accept());
    await row(page, 'Search results load slowly').getByTestId('delete').click();
    await expectCount(row(page, 'Search results load slowly'), 0, 4000);
    await new Promise((ok) => setTimeout(ok, 2000));
    assert((await fetch(`${API}/api/incidents/2`)).status === 404, 'still on the server');
  },
  'detail: title, severity, status, comments in order': async (page) => {
    await page.goto('/incidents/1');
    await expectText(page.locator('h1'), /Checkout returns 502/);
    await expectText(page.getByTestId('severity').first(), /high/i);
    await expectText(page.getByTestId('status').first(), /open/i);
    await expectCount(page.getByTestId('comment'), 2);
    await expectText(page.getByTestId('comment').first(), /Rolled back/);
  },
  'detail: add a comment without a reload': async (page) => {
    await page.goto('/incidents/1');
    await expectCount(page.getByTestId('comment'), 2);
    await page.evaluate(() => { window.__marker = 1; });
    const f = page.getByTestId('comment-form');
    await f.locator('textarea[name=body]').fill('Fixed by restarting the pods.');
    await f.locator('button[type=submit], input[type=submit], button:not([type])').first().click();
    await expectCount(page.getByTestId('comment'), 3, 6000);
    await expectText(page.getByTestId('comment').last(), /restarting the pods/);
    assert(await page.evaluate(() => window.__marker === 1), 'the page reloaded');
    assert((await f.locator('textarea[name=body]').inputValue()) === '', 'not cleared');
  },
  'detail: back link to list': async (page) => {
    await page.goto('/incidents/2');
    await expectText(page.locator('h1'), /Search results/);
    await page.locator('a[href="/"], a[href="./"], a[href="../"], a[href="/index.html"]').first().click();
    await expectCount(items(page), 5);
  },
  'detail: unknown id shows not-found': async (page) => {
    await page.goto('/incidents/999');
    await page.getByTestId('not-found').waitFor();
  },
  'no uncaught page errors on list and detail': async (page, { consoleErrors }) => {
    await page.goto('/'); await expectCount(items(page), 5);
    await page.goto('/incidents/1'); await expectCount(page.getByTestId('comment'), 2);
    assert(consoleErrors.length === 0, consoleErrors.join(' | '));
  },
};

if (app.ok) out.checks = await runChecks(checks, { before: reset, baseURL: `http://127.0.0.1:${PORT}` });
app.server?.stop(); api.stop();
out.passed = out.checks.filter((c) => c.pass).length;
out.total = Object.keys(checks).length;
console.log(JSON.stringify(out, null, 2));
process.exit(0);
