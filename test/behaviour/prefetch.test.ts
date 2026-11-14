// Next-page data: a link to another page of the app requests that page's data ahead, and the
// next page shows it at once, then revalidates.
import { afterEach, expect, test } from 'vitest';
import { compileParts } from '../../src/compiler/compile.js';
import { configure, loginRedirect, onUnauthorized } from '../../src/index.js';
import { config } from '../../src/runtime/config.js';
import { pagePaths, prefetchModule } from '../../src/prefetch-build.js';
import { HOVER, MAX_AGE } from '../../src/prefetch.js';
import { memoryStorage, mockRequests, render, type RouteResponse } from '../../src/testing/index.js';

afterEach(() => { config.request = []; });

const ARTICLE = `<html data-sn-path="/article/:slug"><head></head><body>
  <sn-resource name="article" src="/api/articles/{$url.slug}" items="article"></sn-resource>
  <sn-resource name="comments" src="/api/articles/{$url.slug}/comments" items="comments" key="id"></sn-resource>
  <h1 data-sn-text="article?.title ?? 'loading'"></h1>
  <p data-sn-text="$meta.article.loadedAt ? 'loaded' : 'not loaded'"></p>
  <ul><template data-sn-for="c in comments"><li data-sn-text="c.body"></li></template></ul>
</body></html>`;

const LIST = `
  <sn-resource name="articles" src="/api/articles" items="articles" key="slug"></sn-resource>
  <ul><template data-sn-for="a in articles"><li><a data-sn-attr="{href: '/article/' + a.slug}" data-sn-text="a.title"></a></li></template></ul>
  <a id="away" href="https://elsewhere.example/article/x">elsewhere</a>
  <a id="about" href="/about">about</a>`;

const ROUTES: Record<string, RouteResponse> = {
  'GET /api/articles': { articles: [{ slug: 'one', title: 'One' }, { slug: 'two', title: 'Two' }] },
  'GET /api/articles/one': { article: { slug: 'one', title: 'One, in full' } },
  'GET /api/articles/one/comments': { comments: [{ id: 1, body: 'First!' }] },
};

const link = (root: HTMLElement, slug: string) => root.querySelector(`a[href="/article/${slug}"]`)!;
const fire = (el: Element, type: string, pointerType = 'mouse') => {
  const e = new Event(type, { bubbles: true });
  Object.defineProperty(e, 'pointerType', { value: pointerType });
  return el.dispatchEvent(e);
};
const paths = (r: { calls: Array<{ method: string; url: string }> }) => r.calls.map((c) => `${c.method} ${c.url}`);

async function list(session: Storage, routes = ROUTES) {
  const requests = mockRequests(routes);
  const r = await render(LIST, { session, requests, pages: { 'article.html': ARTICLE } });
  await r.settle();
  return { r, requests };
}

test('resting on a link requests the page\'s data; the page shows it at once, then revalidates', async () => {
  const session = memoryStorage();
  const { r, requests } = await list(session);
  fire(link(r.root, 'one'), 'pointerover');
  await r.advance(HOVER);
  await r.settle();
  expect(paths(requests)).toEqual(['GET /api/articles', 'GET /api/articles/one', 'GET /api/articles/one/comments']);
  // marked as a prefetch on its way through the middleware (the mark is removed before fetch)
  expect(requests.calls[1]!.headers['x-sinter-prefetch']).toBe('1');

  const next = mockRequests({
    'GET /api/articles/one': { article: { slug: 'one', title: 'One, edited' } },
    'GET /api/articles/one/comments': { comments: [{ id: 1, body: 'First!' }, { id: 2, body: 'Second' }] },
  });
  const page = await render(ARTICLE, { session, requests: next, url: '/article/one' });
  // before any response: the prefetched data; not counted as loaded during this page load
  expect(page.root.querySelector('h1')!.textContent).toBe('One, in full');
  expect([...page.root.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['First!']);
  expect(page.root.querySelector('p')!.textContent).toBe('not loaded');
  await page.settle();
  expect(page.root.querySelector('h1')!.textContent).toBe('One, edited');
  expect(page.root.querySelectorAll('li')).toHaveLength(2);
  expect(page.root.querySelector('p')!.textContent).toBe('loaded');
  // taken once: the page after that loads from the server again
  const again = await render(ARTICLE, { session, requests: mockRequests({ 'GET /api/articles/one': { article: null }, 'GET /api/articles/one/comments': { comments: [] } }), url: '/article/one' });
  expect(again.root.querySelector('h1')!.textContent).toBe('loading');
});

test('a touch waits as a hover does; a scroll that starts on a link (pointercancel) requests nothing', async () => {
  const session = memoryStorage();
  const { r, requests } = await list(session, { ...ROUTES, 'GET /api/articles/two': { article: { title: 'Two' } }, 'GET /api/articles/two/comments': { comments: [] } });
  // pointerover comes with a touch too: both start the same wait, once
  fire(link(r.root, 'one'), 'pointerover', 'touch');
  fire(link(r.root, 'one'), 'pointerdown', 'touch');
  await r.advance(HOVER - 10);
  fire(link(r.root, 'one'), 'pointercancel', 'touch');
  await r.advance(100);
  await r.settle();
  expect(paths(requests)).toEqual(['GET /api/articles']);
  fire(link(r.root, 'two'), 'pointerdown', 'touch');
  await r.settle();
  expect(paths(requests)).toEqual(['GET /api/articles']);
  await r.advance(HOVER);
  await r.settle();
  expect(paths(requests)).toEqual(['GET /api/articles', 'GET /api/articles/two', 'GET /api/articles/two/comments']);
});

test('passing over a link quickly requests nothing; a mouse press requests at once', async () => {
  const session = memoryStorage();
  const { r, requests } = await list(session);
  fire(link(r.root, 'one'), 'pointerover');
  await r.advance(HOVER - 10);
  fire(link(r.root, 'one'), 'pointerout');
  await r.advance(100);
  await r.settle();
  expect(paths(requests)).toEqual(['GET /api/articles']);
  fire(link(r.root, 'one'), 'pointerdown');
  await r.settle();
  expect(paths(requests)).toHaveLength(3);
});

test('links to another site, to a page that is not one of the app\'s, or to this page request nothing', async () => {
  const session = memoryStorage();
  const requests = mockRequests(ROUTES);
  const r = await render(LIST, { session, requests, url: '/article/one', pages: { 'article.html': ARTICLE } });
  await r.settle();
  for (const el of [r.root.querySelector('#away')!, r.root.querySelector('#about')!, link(r.root, 'one')]) fire(el, 'pointerdown');
  await r.settle();
  expect(paths(requests)).toEqual(['GET /api/articles']);
});

test('a link followed again soon is not requested twice', async () => {
  const session = memoryStorage();
  const { r, requests } = await list(session);
  fire(link(r.root, 'one'), 'pointerdown');
  await r.settle();
  fire(link(r.root, 'one'), 'pointerdown');
  await r.settle();
  expect(paths(requests)).toHaveLength(3);
});

test('prefetched data older than MAX_AGE is not shown', async () => {
  const session = memoryStorage();
  const { r } = await list(session);
  fire(link(r.root, 'one'), 'pointerdown');
  await r.settle();
  const later = Date.parse('2026-01-01T09:00:00Z') + MAX_AGE + 1000;
  const page = await render(ARTICLE, { session, now: later, requests: mockRequests({ 'GET /api/articles/one': { article: null }, 'GET /api/articles/one/comments': { comments: [] } }), url: '/article/one' });
  expect(page.root.querySelector('h1')!.textContent).toBe('loading');
});

test('a mutation drops what was prefetched, and a prefetch that overlapped one is not kept', async () => {
  const session = memoryStorage();
  const html = `${LIST}<button data-sn-post="/api/articles/one/favorite">fav</button>`;
  const requests = mockRequests({ ...ROUTES, 'POST /api/articles/one/favorite': { ok: true } });
  const r = await render(html, { session, requests, pages: { 'article.html': ARTICLE } });
  await r.settle();
  fire(link(r.root, 'one'), 'pointerdown');
  await r.settle();
  const keys = () => Array.from({ length: session.length }, (_, i) => session.key(i)!).filter((k) => k.startsWith('sn:p:'));
  expect(keys()).toHaveLength(2);
  r.root.querySelector('button')!.click();
  await r.settle();
  expect(keys()).toEqual([]);
  // started while the POST waits: dropped
  r.root.querySelector('button')!.click();
  await r.flush();
  fire(link(r.root, 'two'), 'pointerdown');
  await r.settle().catch(() => {});
  expect(keys()).toEqual([]);
});

test('a 401 on a prefetch does not start the login redirect', async () => {
  const session = memoryStorage();
  configure({ request: [onUnauthorized(loginRedirect({ to: '/login' }))] });
  const { r } = await list(session, { ...ROUTES, 'GET /api/articles/one': { status: 401 }, 'GET /api/articles/one/comments': { status: 401 } });
  fire(link(r.root, 'one'), 'pointerdown');
  await r.settle();
  expect(r.navigations).toEqual([]);
});

test('resources of the next page that read different parts of one response share one request', async () => {
  const session = memoryStorage();
  const book = `<html data-sn-path="/book"><head></head><body>
    <sn-resource name="contacts" src="/api/contacts" items="contacts" key="id"></sn-resource>
    <sn-resource name="books" src="/api/contacts" items="books" key="id"></sn-resource>
    <ul><template data-sn-for="c in contacts"><li data-sn-text="c.name"></li></template></ul>
    <ol><template data-sn-for="b in books"><li data-sn-text="b.name"></li></template></ol>
  </body></html>`;
  const requests = mockRequests({ 'GET /api/contacts': { contacts: [{ id: 1, name: 'Ada' }], books: [{ id: 2, name: 'Work' }] } });
  const r = await render('<a href="/book">book</a>', { session, requests, pages: { 'book.html': book } });
  await r.settle();
  fire(r.root.querySelector('a')!, 'pointerdown');
  await r.settle();
  expect(paths(requests)).toEqual(['GET /api/contacts']);
  const page = await render(book, { session, url: '/book', requests: mockRequests({ 'GET /api/contacts': { contacts: [], books: [] } }) });
  expect(page.root.querySelector('ul li')!.textContent).toBe('Ada');
  expect(page.root.querySelector('ol li')!.textContent).toBe('Work');
});

test('data this page has from the same request is handed over without a request', async () => {
  const session = memoryStorage();
  const user = `<sn-resource name="user" src="/api/user" items="user"></sn-resource><b data-sn-text="user?.name"></b>`;
  const settings = `<html data-sn-path="/settings"><head></head><body>${user}</body></html>`;
  const requests = mockRequests({ 'GET /api/user': { user: { name: 'Ada' } } });
  const r = await render(`${user}<a href="/settings">settings</a>`, { session, requests, pages: { 'settings.html': settings } });
  await r.settle();
  fire(r.root.querySelector('a')!, 'pointerdown');
  await r.settle();
  expect(requests.calls).toHaveLength(1);
  const page = await render(settings, { session, url: '/settings', requests: mockRequests({ 'GET /api/user': { user: { name: 'Ada L.' } } }) });
  expect(page.root.querySelector('b')!.textContent).toBe('Ada');
});

test('the compiler describes only resources whose request the URL decides; helpers come along', () => {
  const html = `<html data-sn-path="/p/:id"><head></head><body><div data-sn-state="{ q: '' }">
    <sn-resource name="a" src="/api/a/{$url.id}?o={offset($url.page)}" items="a" key="id" when="$url.id"></sn-resource>
    <sn-resource name="b" src="/api/b?q={q}" items="b"></sn-resource>
    <sn-resource name="c" src="/api/c?at={a.length}" items="c"></sn-resource>
    <sn-resource name="d" src="/api/d" items="d" paginate="offset" page-size="10"></sn-resource>
    <i data-sn-text="a.length + b.length + c.length + d.length"></i></div></body></html>`;
  const parts = compileParts(html, { file: '/t/p.html', root: '/t', dev: false, readFile: () => '', helpers: { module: '/src/h.js', names: ['offset'], namespaces: {} } });
  expect(parts.prefetch!.path).toEqual(['/p/:id']);
  expect(parts.prefetch!.res.map((r) => r.i)).toEqual(['a']);
  expect(parts.prefetch!.helpers).toEqual(['offset']);
  const mod = prefetchModule([{ paths: parts.prefetch!.path, parts: parts.prefetch! }], { module: '/src/h.js', names: ['offset'], namespaces: {} });
  expect(mod).toContain('import { offset } from "/src/h.js";');
  expect(mod).toContain('export default prefetch([');
  // array parameters: only an app with a page that has them passes `lists` (and carries it)
  expect(mod).not.toMatch(/\blists\b/);
  const withLists = prefetchModule([{ paths: ['/s'], parts: { ...parts.prefetch!, a: ['tag'] } }], { module: null, names: [], namespaces: {} });
  expect(withLists).toContain("import { prefetch, lists } from '@tiaforge-ui/sinter/prefetch';");
  expect(withLists).toMatch(/\], lists\);\n$/);
});

test('a page without data-sn-path answers at its file\'s paths', () => {
  // a page with a fixed path is a directory's index: /login/, and /login redirected there
  expect(pagePaths('login.html', '/', [])).toEqual(['/login/', '/login']);
  expect(pagePaths('docs/index.html', '/app/', [])).toEqual(['/app/docs/', '/app/docs/index.html']);
  expect(pagePaths('index.html', '/', [])).toEqual(['/', '/index.html']);
  expect(pagePaths('a.html', '/', ['/x/:id'])).toEqual(['/x/:id']);
});

test('`<html data-sn-prefetch="off">`: the page is never described; anywhere else it is an error', () => {
  const off = ARTICLE.replace('<html data-sn-path', '<html data-sn-prefetch="off" data-sn-path');
  const opts = { file: '/t/a.html', root: '/t', dev: false, readFile: () => '', helpers: { module: null, names: [], namespaces: {} } };
  const parts = compileParts(off, opts);
  expect(parts.prefetch).toBeNull();
  expect(parts.prefetchOff).toBe(true);
  expect(parts.html).not.toContain('data-sn-prefetch');
  expect(compileParts('<a href="/x" data-sn-prefetch="off">x</a>', opts).diagnostics.map((d) => d.code)).toContain('SN102');
  expect(compileParts('<html data-sn-prefetch="no"><body></body></html>', opts).diagnostics.map((d) => d.code)).toContain('SN401');
});

test("the target page's array parameters are read as lists", async () => {
  const SEARCH = `<html data-sn-path="/search"><head></head><body>
    <select multiple data-sn-model="$url.tag"><option>go</option></select>
    <sn-resource name="hits" src="/api/hits?tag={$url.tag}" items="hits" key="id"></sn-resource>
    <ul><template data-sn-for="h in hits"><li data-sn-text="h.id"></li></template></ul></body></html>`;
  const requests = mockRequests({ 'GET /api/hits': { hits: [] } });
  const r = await render('<a href="/search?tag=go&tag=rs">s</a>', { session: memoryStorage(), requests, pages: { 'search.html': SEARCH } });
  fire(r.root.querySelector('a')!, 'pointerover');
  await r.advance(HOVER);
  await r.settle();
  expect(paths(requests)).toEqual(['GET /api/hits?tag=go&tag=rs']);
});
