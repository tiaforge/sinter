// Hidden checks for T5 (bilingual static site). Usage: node grade.mjs <workspace> → JSON on stdout.
// The expected answers come from the content files themselves (dates, reading times, series, translations).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, buildAndServe, runChecks } from '../../../lib.mjs';
import { measure } from '../../../measure.mjs';

const dir = process.argv[2], PORT = Number(process.env.PREVIEW_PORT ?? 4400), BASE = `http://127.0.0.1:${PORT}`, SITE = 'https://fieldnotes.example';
const content = join(fileURLToPath(new URL('.', import.meta.url)), '../workspace/content');

// --- what the site should contain
const posts = {};
for (const lang of ['en', 'de']) {
  posts[lang] = readdirSync(join(content, lang)).map((f) => {
    const [, fm, body] = readFileSync(join(content, lang, f), 'utf8').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    const m = Object.fromEntries(fm.split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));
    return { slug: f.slice(0, -3), ...m, part: m.part && Number(m.part), draft: m.draft === 'true', words: body.split(/\s+/).filter(Boolean).length };
  }).filter((p) => !p.draft).sort((a, b) => b.date.localeCompare(a.date));
}
const app = await buildAndServe(dir, PORT);
const out = { build: app.build.code === 0, served: app.ok, checks: [], buildLog: app.ok ? undefined : (app.install.out + app.build.out).slice(-3000) };

const pagesOf = (lang) => { const p = posts[lang], r = []; for (let i = 0; i < p.length; i += 2) r.push(p.slice(i, i + 2).map((x) => x.slug)); return r; };
const indexPath = (lang, n) => (n === 1 ? `/${lang}/` : `/${lang}/page/${n}/`);
const post = (lang, slug) => posts[lang].find((p) => p.slug === slug);
const fmtDate = (lang, d) => new Date(d + 'T12:00:00Z').toLocaleDateString(lang === 'en' ? 'en-US' : 'de-DE', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
const readTime = (lang, p) => { const n = Math.max(1, Math.ceil(p.words / 200)); return lang === 'en' ? `${n} min read` : `${n} Min. Lesezeit`; };
const pathOf = (href, from) => { try { const u = new URL(href, BASE + from); return u.pathname; } catch { return null; } };
const norm = (p) => (p ?? '').replace(/index\.html$/, '').replace(/\.html$/, '/').replace(/([^/])$/, '$1/');

const ok = async (page, path) => { const r = await page.goto(path); assert(r && r.status() < 400, `${path} → ${r?.status()}`); return r; };
const missing = async (page, path) => { const r = await page.goto(path); return r.status() >= 400 || (await page.getByTestId('post').count()) === 0 && !(await page.locator('h1').count()); };
const slugsOn = (page, lang) => page.getByTestId('post').evaluateAll((els, lang) => els.map((e) => {
  const a = e.querySelector(`a[href*="/posts/"]`); return a ? a.getAttribute('href').replace(/^.*\/posts\//, '').replace(/\/(index\.html)?$/, '').replace(/\.html$/, '') : null;
}), lang);
const relHref = async (page, rel) => { const a = page.locator(`a[rel~="${rel}"]`); return (await a.count()) ? norm(pathOf(await a.first().getAttribute('href'), new URL(page.url()).pathname)) : null; };
const fetchText = async (path) => { const r = await fetch(BASE + path); assert(r.ok, `${path} → ${r.status}`); return r.text(); };

const checks = {
  'root: / shows or sends you to the English home': async (page) => {
    await ok(page, '/');
    await page.waitForTimeout(1500); // a meta refresh
    const s = await slugsOn(page, 'en');
    assert(new URL(page.url()).pathname.startsWith('/en') || JSON.stringify(s) === JSON.stringify(pagesOf('en')[0]), `at ${page.url()} with ${JSON.stringify(s)}`);
  },
  'index en: 2 per page, newest first, every page, no empty one': async (page) => {
    const pages = pagesOf('en');
    for (let n = 1; n <= pages.length; n++) { await ok(page, indexPath('en', n)); const s = await slugsOn(page); assert(JSON.stringify(s) === JSON.stringify(pages[n - 1]), `page ${n}: ${JSON.stringify(s)}`); }
    assert(await missing(page, indexPath('en', pages.length + 1)), `page ${pages.length + 1} exists`);
  },
  'index de: only German posts, no draft': async (page) => {
    const pages = pagesOf('de');
    for (let n = 1; n <= pages.length; n++) { await ok(page, indexPath('de', n)); const s = await slugsOn(page); assert(JSON.stringify(s) === JSON.stringify(pages[n - 1]), `page ${n}: ${JSON.stringify(s)}`); }
    assert(await missing(page, indexPath('de', pages.length + 1)), `page ${pages.length + 1} exists`);
  },
  'index: rel prev and next only where they exist': async (page) => {
    const last = pagesOf('en').length;
    await ok(page, '/en/');
    assert((await relHref(page, 'prev')) === null, 'prev on page 1');
    assert((await relHref(page, 'next')) === '/en/page/2/', `next on page 1: ${await relHref(page, 'next')}`);
    await ok(page, '/en/page/2/');
    assert(['/en/', '/en/page/1/'].includes(await relHref(page, 'prev')), `prev on page 2: ${await relHref(page, 'prev')}`);
    await ok(page, indexPath('en', last));
    assert((await relHref(page, 'next')) === null, 'next on the last page');
  },
  'dates: written out per language, on posts and lists': async (page) => {
    const en = post('en', 'fermentation-basics-salt'), de = post('de', 'fermentation-basics-salt');
    await ok(page, '/en/posts/fermentation-basics-salt/');
    assert((await page.locator('time').first().getAttribute('datetime'))?.startsWith(en.date), 'datetime');
    assert((await page.locator('time').first().textContent()).includes(fmtDate('en', en.date)), `en: ${await page.locator('time').first().textContent()} ≠ ${fmtDate('en', en.date)}`);
    await ok(page, '/de/posts/fermentation-basics-salt/');
    assert((await page.locator('time').first().textContent()).includes(fmtDate('de', de.date)), `de: ${await page.locator('time').first().textContent()} ≠ ${fmtDate('de', de.date)}`);
    await ok(page, '/de/');
    assert((await page.getByTestId('post').first().textContent()).includes(fmtDate('de', posts.de[0].date)), 'de list date');
  },
  'reading time: computed and worded per language': async (page) => {
    for (const [lang, slug] of [['en', 'fermentation-basics-time'], ['de', 'fermentation-basics-vessels'], ['en', 'notes-on-espresso-dialing']]) {
      await ok(page, `/${lang}/posts/${slug}/`);
      const t = (await page.getByTestId('reading-time').first().textContent()).trim();
      assert(t.includes(readTime(lang, post(lang, slug))), `${lang}/${slug}: "${t}" ≠ "${readTime(lang, post(lang, slug))}"`);
    }
  },
  'series: part n of total, prev and next in the same language': async (page) => {
    await ok(page, '/en/posts/fermentation-basics-vessels/');
    assert(/Part 2 of 3/.test(await page.getByTestId('series').textContent()), 'en text');
    assert((await relHref(page, 'prev')) === '/en/posts/fermentation-basics-salt/', `en prev ${await relHref(page, 'prev')}`);
    assert((await relHref(page, 'next')) === '/en/posts/fermentation-basics-time/', `en next ${await relHref(page, 'next')}`);
    await ok(page, '/en/posts/fermentation-basics-salt/');
    assert((await relHref(page, 'prev')) === null, 'prev on part 1');
    await ok(page, '/de/posts/fermentation-basics-vessels/');
    assert(/Teil 2 von 2/.test(await page.getByTestId('series').textContent()), 'de text (2 German parts)');
    assert((await relHref(page, 'prev')) === '/de/posts/fermentation-basics-salt/', `de prev ${await relHref(page, 'prev')}`);
    assert((await relHref(page, 'next')) === null, 'de next to a part that has no translation');
  },
  'series: none on a post outside a series': async (page) => {
    await ok(page, '/en/posts/notes-on-espresso-dialing/');
    assert((await page.getByTestId('series').count()) === 0, 'series nav');
    assert((await page.locator('a[rel~="prev"], a[rel~="next"]').count()) === 0, 'rel prev/next');
  },
  'html lang, titles, markdown': async (page) => {
    await ok(page, '/de/posts/tuning-the-sourdough-starter/');
    assert((await page.locator('html').getAttribute('lang'))?.startsWith('de'), 'html lang de');
    assert((await page.title()).trim() === 'Den Sauerteig-Starter einstellen | Field Notes', await page.title());
    assert((await page.locator('h2', { hasText: 'Temperatur' }).count()) === 1, 'h2');
    assert((await page.locator('strong', { hasText: '1:5:5' }).count()) === 1, 'strong');
    assert((await page.locator('header a').evaluateAll((as) => as.map((a) => a.getAttribute('href')))).some((h) => /^(https:\/\/fieldnotes\.example)?\/de\/?$/.test(h)), 'header link to /de/');
    await ok(page, '/en/');
    assert((await page.locator('html').getAttribute('lang'))?.startsWith('en'), 'html lang en');
  },
  'switcher: the translation, or the other home': async (page) => {
    const cases = [['/en/posts/tuning-the-sourdough-starter/', 'de', '/de/posts/tuning-the-sourdough-starter/'], ['/en/posts/a-week-of-cold-brew/', 'de', '/de/'],
      ['/de/posts/notes-on-espresso-dialing/', 'en', '/en/posts/notes-on-espresso-dialing/'], ['/en/page/2/', 'de', '/de/'], ['/en/posts/fermentation-basics-time/', 'de', '/de/']];
    for (const [from, lang, want] of cases) {
      await ok(page, from);
      const a = page.locator(`a[hreflang="${lang}"]`);
      assert(await a.count(), `${from}: no a[hreflang=${lang}]`);
      const got = norm(pathOf(await a.first().getAttribute('href'), from));
      assert(got === want, `${from}: ${got} ≠ ${want}`);
    }
  },
  'alternates: absolute, only when translated': async (page) => {
    await ok(page, '/en/posts/tuning-the-sourdough-starter/');
    const alt = await page.locator('link[rel=alternate][hreflang]').evaluateAll((ls) => Object.fromEntries(ls.map((l) => [l.getAttribute('hreflang'), l.getAttribute('href')])));
    assert(alt.en === `${SITE}/en/posts/tuning-the-sourdough-starter/` && alt.de === `${SITE}/de/posts/tuning-the-sourdough-starter/`, JSON.stringify(alt));
    await ok(page, '/en/posts/a-week-of-cold-brew/');
    assert((await page.locator('link[rel=alternate][hreflang]').count()) === 0, 'alternates on an untranslated post');
  },
  'drafts: no page, never linked': async (page) => {
    assert(await missing(page, '/en/posts/kombucha-unfinished/'), 'en draft has a page');
    assert(await missing(page, '/de/posts/a-week-of-cold-brew/'), 'German draft translation has a page');
    for (const p of ['/en/', '/de/', '/en/posts/a-week-of-cold-brew/']) { await ok(page, p); const html = await page.content(); assert(!/kombucha-unfinished|\/de\/posts\/a-week-of-cold-brew/.test(html), `${p} links a draft`); }
  },
  'rss: one feed per language': async () => {
    for (const lang of ['en', 'de']) {
      const x = await fetchText(`/${lang}/rss.xml`);
      assert(/<rss[^>]*version="2.0"/.test(x), `${lang}: not RSS 2.0`);
      assert(new RegExp(`<language>${lang}`).test(x), `${lang}: language`);
      const links = [...x.matchAll(/<item>[\s\S]*?<link>\s*(.*?)\s*<\/link>[\s\S]*?<\/item>/g)].map((m) => m[1]);
      const want = posts[lang].map((p) => `${SITE}/${lang}/posts/${p.slug}/`);
      assert(JSON.stringify(links) === JSON.stringify(want), `${lang}: ${JSON.stringify(links)}`);
    }
  },
  'sitemap: every page, nothing else': async () => {
    const x = await fetchText('/sitemap.xml');
    const locs = new Set([...x.matchAll(/<loc>\s*(.*?)\s*<\/loc>/g)].map((m) => m[1]));
    const want = [];
    for (const lang of ['en', 'de']) { pagesOf(lang).forEach((_, i) => want.push(SITE + indexPath(lang, i + 1))); posts[lang].forEach((p) => want.push(`${SITE}/${lang}/posts/${p.slug}/`)); }
    const lacking = want.filter((u) => !locs.has(u));
    assert(!lacking.length, `missing ${lacking.slice(0, 3).join(', ')}`);
    for (const u of locs) { if (u === `${SITE}/`) continue; const r = await fetch(u.replace(SITE, BASE)); assert(r.ok, `${u} → ${r.status}`); }
  },
  'no JavaScript on any page': async (page) => {
    const paths = ['/en/', '/de/', '/en/page/2/', ...posts.en.map((p) => `/en/posts/${p.slug}/`), ...posts.de.map((p) => `/de/posts/${p.slug}/`)];
    for (const p of paths) { await ok(page, p); const n = await page.locator('script').count(); assert(n === 0, `${p}: ${n} <script>`); }
  },
};

if (app.ok) out.checks = await runChecks(checks, { baseURL: BASE, javaScriptEnabled: false });
if (app.ok) out.measure = await measure({ dir, baseURL: BASE, paths: ['/en/', '/en/posts/fermentation-basics-time/'] });
app.server?.stop();
out.passed = out.checks.filter((c) => c.pass).length;
out.total = Object.keys(checks).length;
console.log(JSON.stringify(out, null, 2));
process.exit(0);
