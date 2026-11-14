// Hidden checks for T4. Usage: node grade.mjs <workspace> → JSON on stdout.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, buildAndServe, runChecks, start, waitForUrl } from '../../../lib.mjs';
import { measure } from '../../../measure.mjs';

const dir = process.argv[2];
const PORT = Number(process.env.PREVIEW_PORT ?? 4400), API_PORT = process.env.API_PORT ?? '3001', API = `http://localhost:${API_PORT}`;
const apiServer = join(fileURLToPath(new URL('.', import.meta.url)), '../workspace/api/server.mjs');
const api = start('node', [apiServer], { env: { PORT: API_PORT, WRITE_DELAY_MS: '1500' } });
await waitForUrl(`${API}/api/me`);
const reset = () => fetch(`${API}/__reset`, { method: 'POST', headers: { connection: 'close' } });

const app = await buildAndServe(dir, PORT);
const out = { build: app.build.code === 0, served: app.ok, checks: [], buildLog: app.ok ? undefined : (app.install.out + app.build.out).slice(-3000) };

// --- helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, msg, ms = 5000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn().catch((e) => `(${e.message.split('\n')[0]})`); if (v === true) return; await sleep(100); } throw new Error(`${msg}${v !== undefined && v !== false ? `: ${JSON.stringify(v)}` : ''}`); };
const bob = async () => { const r = await fetch(`${API}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'bob', password: 'bob-pw' }) }); return (await r.json()).token; };
const asBob = async (method, path, body) => { const t = await bob(); return fetch(`${API}/api${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: body && JSON.stringify(body) }); };
const getIncident = async (id) => { const r = await asBob('GET', `/incidents/${id}`); return r.status === 404 ? null : (await r.json()).incident; };
const items = (page) => page.getByTestId('incident');
const row = (page, text) => items(page).filter({ hasText: text });
const titles = (page) => items(page).evaluateAll((els) => els.map((e) => (e.querySelector('[data-testid="title"]')?.textContent ?? '').trim()));
const submit = (form) => form.locator('button[type=submit], input[type=submit], button:not([type])').first().click();
const isLogin = (page) => new URL(page.url()).pathname.replace(/\/$/, '').endsWith('/login');
async function signIn(page, path = '/') {
  await page.goto(path);
  await until(async () => isLogin(page), `not sent to /login from ${path}`);
  const f = page.getByTestId('login');
  await f.locator('[name=username]').fill('alice');
  await f.locator('[name=password]').fill('alice-pw');
  await submit(f);
  await until(async () => !isLogin(page), 'still on /login after signing in');
}
const board = async (page, path = '/') => { await signIn(page, path); await until(async () => (await items(page).count()) > 0, 'no incidents listed'); };
const params = (page) => Object.fromEntries(new URL(page.url()).searchParams);
const NEWEST = [...Array(23).keys()].map((i) => 23 - i); // ids, newest first
const T = ['Checkout returns 502 for EU customers', 'Search results load slowly', 'Typo on the pricing page', '[locked] Database failover drill',
  'Password reset email delayed', 'CDN cache miss rate doubled', 'Mobile app crashes on login', 'Invoice PDF has wrong VAT', 'Webhook retries pile up',
  'Status page shows stale data', 'Disk usage alert on db-2', 'SSO login loops for Okta users', 'Export to CSV times out', 'Dark mode contrast too low',
  'Push notifications arrive twice', 'Rate limiter blocks partners', 'Search index out of date', 'Signup form rejects plus addresses',
  'Images fail to load in Safari', 'Nightly backup took 6 hours', 'Billing page shows old plan', 'Audit log missing entries', 'Map tiles render blank'];
const title = (id) => T[id - 1];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const checks = {
  // signing in
  'auth: signed out, the board sends you to /login': async (page) => {
    await page.goto('/');
    await until(async () => isLogin(page), 'not on /login');
  },
  'auth: a wrong password shows the API message': async (page) => {
    await page.goto('/login');
    const f = page.getByTestId('login');
    await f.locator('[name=username]').fill('alice'); await f.locator('[name=password]').fill('nope');
    await submit(f);
    await until(async () => /Wrong username or password/.test(await page.getByTestId('error').first().textContent()), 'no error');
  },
  'auth: back to the page first asked for, with its query': async (page) => {
    await signIn(page, '/?status=open&page=2');
    await until(async () => { const u = new URL(page.url()); return (u.pathname === '/' && u.searchParams.get('status') === 'open' && u.searchParams.get('page') === '2') || page.url(); }, 'wrong page after sign-in');
    await until(async () => /Page 2 of 2/.test(await page.getByTestId('page').textContent()), 'page text');
  },
  'auth: lasts across a reload and a new tab': async (page) => {
    await board(page);
    await page.reload();
    await until(async () => (await items(page).count()) === 10, 'not signed in after reload');
    const p2 = await page.context().newPage();
    await p2.goto('/incidents/3');
    await until(async () => (await p2.locator('h1').textContent()).includes(title(3)), 'not signed in in a new tab');
  },
  'auth: user name, sign out, stays signed out': async (page) => {
    await board(page);
    await until(async () => /alice/.test(await page.getByTestId('user').textContent()), 'no user name');
    await page.getByTestId('logout').click();
    await until(async () => isLogin(page), 'not on /login after sign-out');
    await page.goto('/');
    await until(async () => isLogin(page), 'board shown after sign-out');
  },
  'auth: a token that stops working sends you to /login': async (page) => {
    await board(page);
    const t = await (await fetch(`${API}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'alice-pw' }) })).json();
    await fetch(`${API}/api/logout`, { method: 'POST', headers: { authorization: `Bearer ${t.token}` } }); // ends every alice token
    await page.reload();
    await until(async () => isLogin(page), 'not on /login');
  },
  // the board
  'board: 10 per page, newest first, page count': async (page) => {
    await board(page);
    await until(async () => same(await titles(page), NEWEST.slice(0, 10).map(title)) || (await titles(page)), 'page 1');
    await until(async () => /Page 1 of 3/.test(await page.getByTestId('page').textContent()), 'page text');
    await until(async () => (await row(page, title(22)).getByTestId('severity').textContent()).trim() === 'high' && (await row(page, title(22)).getByTestId('status').textContent()).trim() === 'open', 'severity/status of 22');
    await until(async () => (await row(page, title(23)).getByTestId('severity').textContent()).trim() === 'medium' && (await row(page, title(23)).getByTestId('status').textContent()).trim() === 'resolved', 'severity/status of 23');
  },
  'board: next page in the URL, Back and Forward': async (page) => {
    await board(page);
    await page.getByTestId('next').click();
    await until(async () => params(page).page === '2' || page.url(), 'page=2 not in URL');
    await until(async () => same(await titles(page), NEWEST.slice(10, 20).map(title)) || (await titles(page)), 'page 2');
    await page.goBack();
    await until(async () => same(await titles(page), NEWEST.slice(0, 10).map(title)) || (await titles(page)), 'page 1 after Back');
    await page.goForward();
    await until(async () => same(await titles(page), NEWEST.slice(10, 20).map(title)) || (await titles(page)), 'page 2 after Forward');
  },
  'board: search is in the URL and does not send a request per keystroke': async (page) => {
    await board(page);
    let searches = 0;
    page.on('request', (r) => { if (/\/api\/incidents\?.*q=/.test(r.url())) searches++; });
    await page.getByTestId('search').pressSequentially('search', { delay: 40 });
    await until(async () => same((await titles(page)).sort(), [title(2), title(17)].sort()) || (await titles(page)), 'search results');
    await until(async () => params(page).q === 'search' || page.url(), 'q not in URL');
    assert(searches <= 3, `${searches} search requests for 6 keystrokes`);
  },
  'board: status and sort combine, survive a reload': async (page) => {
    await board(page);
    await page.getByTestId('status-filter').selectOption('open');
    await page.getByTestId('sort').selectOption('severity');
    const want = [22, 16, 13, 10, 4, 1, 20, 17, 14, 8].map(title); // open: high newest first, then medium
    await until(async () => same(await titles(page), want) || (await titles(page)), 'open by severity');
    await until(async () => (params(page).status === 'open' && params(page).sort === 'severity') || page.url(), 'not in URL');
    await page.reload();
    await until(async () => same(await titles(page), want) || (await titles(page)), 'after reload');
  },
  'board: changing a filter goes back to page 1': async (page) => {
    await board(page, '/?page=3');
    await until(async () => /Page 3 of 3/.test(await page.getByTestId('page').textContent()), 'page 3');
    await page.getByTestId('status-filter').selectOption('resolved');
    await until(async () => (!params(page).page || params(page).page === '1') || page.url(), 'page not reset');
    await until(async () => /Page 1 of 1/.test(await page.getByTestId('page').textContent()), 'page text');
  },
  'create: shows without a reload, field cleared; 422 kept': async (page) => {
    await board(page);
    await page.evaluate(() => { window.__marker = 1; });
    const f = page.getByTestId('create');
    await f.locator('[name=title]').fill('Pager went off at 3am');
    await f.locator('select[name=severity]').selectOption('high');
    await submit(f);
    await until(async () => (await titles(page))[0] === 'Pager went off at 3am' || (await titles(page))[0], 'not at the top', 6000);
    assert(await page.evaluate(() => window.__marker === 1), 'the page reloaded');
    assert((await f.locator('[name=title]').inputValue()) === '', 'title not cleared');
    const long = 'x'.repeat(81);
    await f.locator('[name=title]').fill(long);
    await submit(f);
    await until(async () => /at most 80 characters/.test(await page.getByTestId('error').first().textContent()), 'no 422 message', 6000);
    assert((await f.locator('[name=title]').inputValue()) === long, 'input not kept');
  },
  // live
  'live: an incident created by someone else appears at the top': async (page) => {
    await board(page); await sleep(500);
    await asBob('POST', '/incidents', { title: 'Created by Bob', severity: 'medium' });
    await until(async () => (await titles(page))[0] === 'Created by Bob' || (await titles(page))[0], 'not shown', 3000 + 1500);
  },
  'live: a title and a status changed by someone else': async (page) => {
    await board(page); await sleep(500);
    await asBob('PATCH', '/incidents/23', { version: 1, title: 'Map tiles fixed by Bob' });
    await until(async () => (await row(page, 'Map tiles fixed by Bob').count()) === 1, 'title not updated', 4500);
    await asBob('PATCH', '/incidents/21', { version: 1, status: 'resolved' });
    await until(async () => (await row(page, title(21)).getByTestId('status').textContent()).trim() === 'resolved', 'status not updated', 4500);
  },
  'live: an incident deleted by someone else disappears': async (page) => {
    await board(page); await sleep(500);
    await asBob('DELETE', '/incidents/22');
    await until(async () => (await row(page, title(22)).count()) === 0, 'still listed', 4500);
  },
  // writes
  'resolve and reopen: shown at once, saved': async (page) => {
    await board(page);
    const r = row(page, title(22));
    await r.getByTestId('resolve').click();
    await until(async () => (await r.getByTestId('status').textContent()).trim() === 'resolved', 'not at once', 700);
    await until(async () => (await getIncident(22)).status === 'resolved', 'not saved', 4000);
    await r.getByTestId('reopen').click();
    await until(async () => (await r.getByTestId('status').textContent()).trim() === 'open', 'reopen not at once', 700);
    await until(async () => (await getIncident(22)).status === 'open', 'reopen not saved', 4000);
  },
  'resolve: rolled back with an error when refused': async (page) => {
    await board(page, '/?q=locked');
    await until(async () => (await items(page).count()) === 1, 'search for the locked one');
    const r = row(page, 'Database failover drill');
    await r.getByTestId('resolve').click();
    await until(async () => /\S/.test(await page.getByTestId('error').first().textContent()), 'no error', 4500);
    await until(async () => (await r.getByTestId('status').textContent()).trim() === 'open', 'not rolled back', 3000);
  },
  'rename: shown at once, saved': async (page) => {
    await board(page);
    await row(page, title(23)).getByTestId('edit').click();
    const input = items(page).first().locator('input[name=title]');
    await input.fill('Map tiles render grey');
    await input.press('Enter');
    await until(async () => (await row(page, 'Map tiles render grey').count()) === 1, 'not at once', 800);
    await until(async () => (await getIncident(23)).title === 'Map tiles render grey', 'not saved', 4000);
  },
  'rename: a conflict is shown with the current title': async (page) => {
    await page.route(/\/api\/events/, (r) => r.abort()); // this tab misses Bob's change
    await board(page);
    await asBob('PATCH', '/incidents/23', { version: 1, title: 'Bob renamed it' });
    await row(page, title(23)).getByTestId('edit').click();
    const input = items(page).first().locator('input[name=title]');
    await input.fill('Alice renamed it');
    await input.press('Enter');
    await until(async () => (await page.getByTestId('conflict').count()) > 0 && /\S/.test(await page.getByTestId('conflict').first().textContent()), 'no conflict shown', 5000);
    await until(async () => (await row(page, 'Bob renamed it').count()) === 1, 'current title not shown', 3000);
    assert((await getIncident(23)).title === 'Bob renamed it', 'overwrote Bob');
  },
  'delete: undo puts it back, nothing deleted': async (page) => {
    await board(page);
    page.on('dialog', (d) => d.accept());
    await row(page, title(21)).getByTestId('delete').click();
    await until(async () => (await row(page, title(21)).count()) === 0, 'not removed at once', 800);
    await page.getByTestId('undo').click();
    await until(async () => (await row(page, title(21)).count()) === 1, 'not back after undo', 2000);
    await sleep(6500);
    assert(await getIncident(21), 'deleted on the server despite undo');
  },
  'delete: without undo, deleted after 5 seconds': async (page) => {
    await board(page);
    page.on('dialog', (d) => d.accept());
    await row(page, title(21)).getByTestId('delete').click();
    await until(async () => (await page.getByTestId('undo').count()) > 0, 'no undo button', 1500);
    await sleep(2500);
    assert(await getIncident(21), 'deleted before 5 seconds');
    await until(async () => (await getIncident(21)) === null || 'still on the server', 'not deleted', 7000);
    await until(async () => (await page.getByTestId('undo').count()) === 0 || !(await page.getByTestId('undo').first().isVisible()), 'undo still shown', 2000);
  },
  // detail
  'detail: title, updated-by, live changes': async (page) => {
    await signIn(page, '/incidents/23');
    await until(async () => (await page.locator('h1').textContent()).includes(title(23)), 'h1');
    await until(async () => /alice/.test(await page.getByTestId('updated-by').textContent()), 'updated-by');
    await sleep(500);
    await asBob('PATCH', '/incidents/23', { version: 1, title: 'Changed while open' });
    await until(async () => (await page.locator('h1').textContent()).includes('Changed while open'), 'title not live', 4500);
    await until(async () => /bob/.test(await page.getByTestId('updated-by').textContent()), 'updated-by not live', 2000);
  },
  'detail: not found, and deleted while open': async (page) => {
    await signIn(page, '/incidents/999');
    await page.getByTestId('not-found').waitFor();
    await page.goto('/incidents/20');
    await until(async () => (await page.locator('h1').textContent()).includes(title(20)), 'h1');
    await sleep(500);
    await asBob('DELETE', '/incidents/20');
    await page.getByTestId('not-found').waitFor({ timeout: 4500 });
  },
  'no uncaught page errors': async (page, { consoleErrors }) => {
    await board(page);
    await page.goto('/incidents/1');
    await until(async () => (await page.locator('h1').textContent()).includes(title(1)), 'h1');
    assert(consoleErrors.length === 0, consoleErrors.join(' | '));
  },
};

if (app.ok) out.checks = await runChecks(checks, { before: reset, baseURL: `http://127.0.0.1:${PORT}` });
if (app.ok) { await reset(); out.measure = await measure({ dir, baseURL: `http://127.0.0.1:${PORT}`, paths: ['/login', '/'], lighthousePaths: ['/login'], setup: (page) => signIn(page, '/').catch(() => {}) }); }
app.server?.stop(); api.stop();
out.passed = out.checks.filter((c) => c.pass).length;
out.total = Object.keys(checks).length;
console.log(JSON.stringify(out, null, 2));
process.exit(0);
