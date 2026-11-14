// Hidden checks for T2. Usage: node grade.mjs <workspace> → JSON on stdout.
// The browser's calls to api.realworld.show are answered by route interception; a server-rendering app's own
// fetches go to the same data over HTTP (REALWORLD_API, set up by setup.mjs for SvelteKit).
import { createServer } from 'node:http';
import { assert, buildAndServe, runChecks } from '../../../lib.mjs';

const dir = process.argv[2], PORT = Number(process.env.PREVIEW_PORT ?? 4400), BASE = `http://127.0.0.1:${PORT}`;

// --- the fixed API: 14 articles, the first tag of each decides the "related" lists
const author = (i) => ({ username: `author${i % 3}`, bio: 'Writes.', image: null, following: false });
const TAGS = { 1: ['html', 'css'], 2: ['css'], 3: ['html'], 4: [], 5: ['html', 'web'], 6: ['rust'], 7: ['html'], 8: ['css', 'html'], 9: ['web'], 10: ['html'], 11: ['go'], 12: ['web'], 13: ['css'], 14: ['go'] };
const BODY = {
  1: '# Getting started\n\nIntro text with **bold**.\n\n## Part 2: Details\n\nMore.\n\n### Not in the TOC\n\nDeep.\n\n## Wrap-up!\n\nEnd.',
  4: 'A body with no headings at all.\n\nJust paragraphs.',
};
const article = (i) => ({
  slug: `article-${i}`, title: `Article number ${i}`, description: `About ${i}.`, body: BODY[i] ?? `# Heading of ${i}\n\nText of ${i}.`,
  tagList: TAGS[i], createdAt: new Date(Date.UTC(2026, 0, i)).toISOString(), updatedAt: new Date(Date.UTC(2026, 0, i)).toISOString(),
  favorited: false, favoritesCount: i, author: author(i),
});
const ARTICLES = Object.keys(TAGS).map(Number).sort((a, b) => b - a).map(article);
const requests = [];
function route(url) {
  const u = new URL(url), p = u.pathname.replace(/^\/api/, ''), q = u.searchParams; let m;
  requests.push(p + u.search);
  if (p === '/tags') return [200, { tags: ['html', 'css', 'web', 'rust', 'go'] }];
  if (p === '/user') return [401, { errors: { token: ['missing'] } }];
  if ((m = p.match(/^\/articles\/([^/]+)\/comments$/))) return [200, { comments: [{ id: 1, body: 'First comment.', createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z', author: author(1) }] }];
  if ((m = p.match(/^\/articles\/([^/]+)$/))) { const a = ARTICLES.find((x) => x.slug === m[1]); return a ? [200, { article: a }] : [404, { errors: { article: ['not found'] } }]; }
  if ((m = p.match(/^\/profiles\/([^/]+)$/))) return [200, { profile: author(Number(m[1].replace(/\D/g, '')) || 0) }];
  if (p === '/articles' || p === '/articles/feed') {
    let list = ARTICLES;
    if (q.get('tag')) list = list.filter((a) => a.tagList.includes(q.get('tag')));
    if (q.get('author')) list = list.filter((a) => a.author.username === q.get('author'));
    const offset = Number(q.get('offset') ?? 0), limit = Number(q.get('limit') ?? 20);
    return [200, { articles: list.slice(offset, offset + limit).map(({ body, ...a }) => a), articlesCount: list.length }];
  }
  return [404, { errors: { path: ['unknown'] } }];
}
const http = createServer((req, res) => {
  const [status, body] = route(`http://x${req.url}`);
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body));
}).listen(0, '127.0.0.1');
await new Promise((r) => http.once('listening', r));
const REALWORLD_API = `http://127.0.0.1:${http.address().port}/api`;

const app = await buildAndServe(dir, PORT, { REALWORLD_API });
const out = { build: app.build.code === 0, served: app.ok, checks: [], buildLog: app.ok ? undefined : (app.install.out + app.build.out).slice(-3000) };

const intercept = async (page) => {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, async (r) => {
    const url = r.request().url();
    if (url.startsWith('https://api.realworld.show/api/')) {
      if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      const [status, body] = route(url);
      return r.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    }
    return r.fulfill({ status: 200, body: '' }); // fonts, icons, theme CDNs: empty
  });
};
// fn returns true when satisfied; anything else is kept as the last value seen, for the message
const waitFor = async (fn, msg, ms = 6000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v === true) return v; await new Promise((r) => setTimeout(r, 100)); } throw new Error(msg + (v === undefined || v === false ? '' : `: ${JSON.stringify(v)}`)); };
const settle = (page) => page.waitForLoadState('networkidle').catch(() => {});
const tocOf = (page) => page.locator('nav.article-toc a').evaluateAll((as) => as.map((a) => [a.textContent.trim(), a.getAttribute('href')]));
const relatedOf = (page) => page.locator('section.related-articles a.related-link').evaluateAll((as) => as.map((a) => [a.textContent.trim(), a.getAttribute('href')]));

const checks = {
  'regression: home lists articles': async (page) => {
    await intercept(page); await page.goto('/');
    await waitFor(async () => (await page.locator('.article-preview').count()) >= 10, 'fewer than 10 previews');
  },
  'regression: article page shows title, body and comments': async (page) => {
    await intercept(page); await page.goto('/article/article-3');
    await waitFor(async () => /Article number 3/.test(await page.locator('h1').first().textContent().catch(() => '')), 'no title');
    await waitFor(async () => /Text of 3/.test(await page.locator('.article-content').textContent().catch(() => '')), 'no body');
    await waitFor(async () => /First comment/.test(await page.content()), 'no comment');
  },
  'regression: preview links to the article page': async (page) => {
    await intercept(page); await page.goto('/');
    await page.locator('.article-preview a.preview-link').first().click();
    await page.waitForURL(/\/article\/article-14/);
    await waitFor(async () => /Article number 14/.test(await page.locator('h1').first().textContent().catch(() => '')), 'no title');
  },
  'toc: # and ## headings in order, with slug hrefs': async (page) => {
    await intercept(page); await page.goto('/article/article-1');
    const want = [['Getting started', '#getting-started'], ['Part 2: Details', '#part-2-details'], ['Wrap-up!', '#wrap-up']];
    await waitFor(async () => { const t = await tocOf(page); return JSON.stringify(t) === JSON.stringify(want) || t; }, 'toc');
  },
  'toc: every href targets a heading id in the body': async (page) => {
    await intercept(page); await page.goto('/article/article-1');
    await waitFor(async () => (await tocOf(page)).length === 3, 'toc');
    for (const id of ['getting-started', 'part-2-details', 'wrap-up']) {
      await waitFor(async () => (await page.locator(`.article-content :is(h1,h2)[id="${id}"]`).count()) === 1, `no heading #${id} in .article-content`);
    }
  },
  'toc: placed above the body': async (page) => {
    await intercept(page); await page.goto('/article/article-1');
    await waitFor(async () => (await tocOf(page)).length === 3, 'toc');
    const before = await page.evaluate(() => { const t = document.querySelector('nav.article-toc'), b = document.querySelector('.article-content'); return !!(t && b && t.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING && !t.contains(b) && !b.contains(t)); });
    assert(before, 'nav.article-toc is not before .article-content');
  },
  'toc: absent without headings': async (page) => {
    await intercept(page); await page.goto('/article/article-4');
    await waitFor(async () => /no headings/.test(await page.locator('.article-content').textContent().catch(() => '')), 'no body');
    await settle(page);
    assert(await page.locator('nav.article-toc').count() === 0, 'nav.article-toc present');
  },
  'toc: updates when moving to another article': async (page) => {
    await intercept(page); await page.goto('/article/article-1');
    await waitFor(async () => (await tocOf(page)).length === 3, 'toc');
    await page.goto('/article/article-10');
    await waitFor(async () => { const t = await tocOf(page); return JSON.stringify(t) === JSON.stringify([['Heading of 10', '#heading-of-10']]) || t; }, 'toc');
  },
  'related: up to 3, first tag, newest first, not itself': async (page) => {
    await intercept(page); await page.goto('/article/article-5');
    const want = [['Article number 10', '/article/article-10'], ['Article number 8', '/article/article-8'], ['Article number 7', '/article/article-7']];
    await waitFor(async () => { const r = await relatedOf(page); return JSON.stringify(r) === JSON.stringify(want) || r; }, 'related');
    assert(/More on html/.test(await page.locator('section.related-articles h3').textContent()), 'h3');
  },
  'related: excludes itself and only uses the first tag': async (page) => {
    await intercept(page); await page.goto('/article/article-8'); // first tag css: 13, 2, 1 (8 itself left out)
    const want = [['Article number 13', '/article/article-13'], ['Article number 2', '/article/article-2'], ['Article number 1', '/article/article-1']];
    await waitFor(async () => { const r = await relatedOf(page); return JSON.stringify(r) === JSON.stringify(want) || r; }, 'related');
    assert(/More on css/.test(await page.locator('section.related-articles h3').textContent()), 'h3');
  },
  'related: fewer than 3 available': async (page) => {
    await intercept(page); await page.goto('/article/article-14'); // go: only 11
    await waitFor(async () => { const r = await relatedOf(page); return JSON.stringify(r) === JSON.stringify([['Article number 11', '/article/article-11']]) || r; }, 'related');
  },
  'related: absent without tags or without others': async (page) => {
    await intercept(page); await page.goto('/article/article-4');
    await waitFor(async () => /no headings/.test(await page.locator('.article-content').textContent().catch(() => '')), 'no body');
    await settle(page);
    assert(await page.locator('section.related-articles').count() === 0, 'section present (no tags)');
    await page.goto('/article/article-6'); // rust: only itself
    await waitFor(async () => /Text of 6/.test(await page.locator('.article-content').textContent().catch(() => '')), 'no body');
    await settle(page);
    assert(await page.locator('section.related-articles').count() === 0, 'section present (no others)');
  },
  'related: between article and comments, links work': async (page) => {
    await intercept(page); await page.goto('/article/article-5');
    await waitFor(async () => (await relatedOf(page)).length === 3, 'related');
    const ok = await page.evaluate(() => {
      const s = document.querySelector('section.related-articles'), b = document.querySelector('.article-content');
      const c = document.querySelector('textarea[placeholder="Write a comment..."]') ?? [...document.querySelectorAll('*')].find((e) => /First comment/.test(e.textContent) && !e.children.length) ?? document.querySelector('.card');
      const F = Node.DOCUMENT_POSITION_FOLLOWING;
      return !!(s && b && (b.compareDocumentPosition(s) & F) && (!c || (s.compareDocumentPosition(c) & F)));
    });
    assert(ok, 'section not between body and comments');
    await page.locator('a.related-link').first().click();
    await page.waitForURL(/\/article\/article-10/);
    await waitFor(async () => /Article number 10/.test(await page.locator('h1').first().textContent().catch(() => '')), 'no title after click');
  },
};

if (app.ok) out.checks = await runChecks(checks, { baseURL: BASE });
app.server?.stop(); http.close();
out.passed = out.checks.filter((c) => c.pass).length;
out.total = Object.keys(checks).length;
console.log(JSON.stringify(out, null, 2));
process.exit(0);
