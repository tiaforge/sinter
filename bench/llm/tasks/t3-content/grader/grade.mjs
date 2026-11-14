// Hidden checks for T3 (static content site). Usage: node grade.mjs <workspace> → JSON on stdout.
import { assert, buildAndServe, runChecks } from '../../../lib.mjs';
import { measure } from '../../../measure.mjs';

const dir = process.argv[2], PORT = Number(process.env.PREVIEW_PORT ?? 4400), BASE = `http://127.0.0.1:${PORT}`;
const app = await buildAndServe(dir, PORT);
const out = { build: app.build.code === 0, served: app.ok, checks: [], buildLog: app.ok ? undefined : (app.install.out + app.build.out).slice(-3000) };

const PUBLISHED = ['notes-on-espresso-dialing', 'pickles-without-vinegar', 'fermenting-hot-sauce', 'a-week-of-cold-brew', 'tuning-the-sourdough-starter'];
const slugsOn = (page) => page.getByTestId('post').evaluateAll((els) => els.map((e) => {
  const a = e.querySelector('a[href*="/posts/"]'); return a ? a.getAttribute('href').replace(/^.*\/posts\//, '').replace(/\/$/, '').replace(/\.html$/, '') : null;
}));
const ok = async (page, path) => { const r = await page.goto(path); assert(r && r.status() < 400, `${path} → ${r?.status()}`); return r; };

const checks = {
  'home: published posts, newest first, no draft': async (page) => {
    await ok(page, '/');
    const s = await slugsOn(page);
    assert(JSON.stringify(s) === JSON.stringify(PUBLISHED), `got ${JSON.stringify(s)}`);
  },
  'home: time datetime and description': async (page) => {
    await ok(page, '/');
    const p = page.getByTestId('post').first();
    assert((await p.locator('time').getAttribute('datetime'))?.startsWith('2026-10-30'), 'datetime');
    assert(/Ratio first, then time/.test(await p.textContent()), 'description');
  },
  'home: <title> is Field Notes': async (page) => { await ok(page, '/'); assert((await page.title()).trim() === 'Field Notes', await page.title()); },
  'post: h1, time, rendered markdown': async (page) => {
    await ok(page, '/posts/tuning-the-sourdough-starter/');
    assert((await page.locator('h1').first().textContent()).includes('Tuning the sourdough starter'), 'h1');
    assert((await page.locator('time').first().getAttribute('datetime'))?.startsWith('2026-03-14'), 'time');
    assert(await page.locator('h2', { hasText: 'Temperature' }).count() === 1, 'h2 Temperature');
    assert(await page.locator('strong', { hasText: '1:5:5' }).count() === 1, 'bold');
    assert(await page.locator('a[href="https://example.com/hydration"]').count() === 1, 'link');
  },
  'post: code block as pre > code': async (page) => {
    await ok(page, '/posts/a-week-of-cold-brew/');
    assert(/day 1: 16 h/.test(await page.locator('pre code').first().textContent()), 'pre code');
  },
  'post: <title> and meta description': async (page) => {
    await ok(page, '/posts/fermenting-hot-sauce/');
    assert((await page.title()).trim() === 'Fermenting hot sauce | Field Notes', await page.title());
    assert((await page.locator('meta[name=description]').getAttribute('content'))?.includes('Two percent brine'), 'description');
  },
  'post: tags link to tag pages': async (page) => {
    await ok(page, '/posts/fermenting-hot-sauce/');
    for (const t of ['fermentation', 'preserving']) assert(await page.locator(`a[href^="/tags/${t}"]`).count() >= 1, `no link to /tags/${t}/`);
  },
  'post: no JavaScript': async (page) => {
    for (const s of PUBLISHED) { await ok(page, `/posts/${s}/`); const n = await page.locator('script').count(); assert(n === 0, `${s}: ${n} <script>`); }
  },
  'post: draft has no page': async (page) => {
    const r = await page.goto('/posts/unfinished-kombucha-post/');
    const body = (await page.content());
    assert(r.status() === 404 || !/TODO\./.test(body), `status ${r.status()}`);
  },
  'tags: fermentation lists published posts newest first': async (page) => {
    await ok(page, '/tags/fermentation/');
    assert((await page.locator('h1').first().textContent()).toLowerCase().includes('fermentation'), 'h1');
    const s = await slugsOn(page);
    assert(JSON.stringify(s) === JSON.stringify(['pickles-without-vinegar', 'fermenting-hot-sauce', 'tuning-the-sourdough-starter']), JSON.stringify(s));
  },
  'tags: a page for every published tag': async (page) => {
    for (const t of ['baking', 'coffee', 'preserving']) { await ok(page, `/tags/${t}/`); assert(await page.getByTestId('post').count() >= 1, t); }
  },
  'header link to / on every page type': async (page) => {
    for (const p of ['/posts/pickles-without-vinegar/', '/tags/coffee/']) { await ok(page, p); assert(await page.locator('header a[href="/"]').count() >= 1, p); }
  },
  'rss: valid items, newest first, absolute links, no draft': async () => {
    const r = await fetch(`${BASE}/rss.xml`); assert(r.ok, `status ${r.status}`);
    const x = await r.text();
    assert(/<rss[^>]*version="2.0"/.test(x), 'not RSS 2.0');
    const items = [...x.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
    assert(items.length === 5, `${items.length} items`);
    const links = items.map((i) => (i.match(/<link>\s*(.*?)\s*<\/link>/) || [])[1]);
    assert(links[0]?.startsWith('https://fieldnotes.example/posts/notes-on-espresso-dialing'), `first link ${links[0]}`);
    assert(items.every((i) => /<pubDate>/.test(i) && /<description>/.test(i) && /<title>/.test(i)), 'missing fields');
    assert(!/kombucha/i.test(x), 'draft in feed');
  },
};

if (app.ok) out.checks = await runChecks(checks, { baseURL: BASE, javaScriptEnabled: false });
if (app.ok) out.measure = await measure({ dir, baseURL: BASE, paths: ['/', '/posts/tuning-the-sourdough-starter/'] });
app.server?.stop();
out.passed = out.checks.filter((c) => c.pass).length;
out.total = Object.keys(checks).length;
console.log(JSON.stringify(out, null, 2));
process.exit(0);
