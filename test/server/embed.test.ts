// @vitest-environment node
// @tiaforge-ui/sinter/server: packages/sinter-axum's tests/embed.rs, on fetch handlers.
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { embed, type EmbedOptions, type Handler } from '../../src/server.js';

const HEAD = '<!DOCTYPE html><html><head><link rel="stylesheet" href="/assets/app.css">';
/** `‹` stands for the JSON escape the layer writes for `<` */
const E = (s: string) => s.replace(/‹/g, '\\u003c');

const root = mkdtempSync(join(tmpdir(), 'sinter-server-'));
let n = 0;
function build(manifest: string, pages: Record<string, string> = {}) {
  const dir = join(root, String(n++));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sinter-embed.json'), manifest);
  for (const [f, html] of Object.entries(pages)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), html);
  }
  return dir;
}

/** RealWorld's shape: a list and its tags on `/`, an article and its comments. */
const appBuild = () => build(`{ "version": 2, "pages": [
  { "file": "index.html", "paths": ["/", "/index.html"], "data": [
    { "id": 3, "resource": "articles", "src": ["/api/articles?tag=", { "url": "tag" }, "&limit=10"] },
    { "id": 4, "resource": "tags", "src": ["/api/tags"] },
    { "id": 5, "resource": "feed", "src": ["/api/feed"], "when": true } ] },
  { "file": "article.html", "paths": ["/article/:slug"], "data": [
    { "id": 0, "resource": "article", "src": ["/api/articles/", { "url": "slug" }] },
    { "id": 1, "resource": "comments", "src": ["/api/articles/", { "url": "slug" }, "/comments"] } ] } ] }`, {
  'index.html': `${HEAD}<script type="application/json" data-sn="3"></script><script type="application/json" data-sn="4"></script><script type="application/json" data-sn="5"></script></head><body><main></main></body></html>`,
  'article.html': `${HEAD}<script type="application/json" data-sn="0"></script><script type="application/json" data-sn="1"></script></head><body></body></html>`,
});

const json = (v: string, status = 200) => new Response(v, { status, headers: { 'content-type': 'application/json' } });

/** the API, and a stand-in for the static files: what an app's fetch handler is */
const api: Handler = (req) => {
  const u = new URL(req.url);
  if (u.pathname == '/api/articles') return json(`{"articles":[{"title":"</script><b>x"}],"q":"${u.search.slice(1)}","who":"${req.headers.get('cookie') ?? '-'}"}`);
  if (u.pathname == '/api/tags') return json('{"tags":["a"]}');
  const m = /^\/api\/articles\/([^/]+)(\/comments)?$/.exec(u.pathname);
  if (m?.[2]) return new Response('no', { status: 500 });
  if (m) return json(`{"article":{"slug":"${decodeURIComponent(m[1]!)}"}}`);
  return new Response(`static file`);
};

async function app(options: EmbedOptions, handler: Handler = api) {
  const e = await embed({ onError: () => {}, ...options });
  return (path: string, init?: RequestInit) => e.wrap(handler)(new Request('http://app.test' + path, init));
}
const text = async (r: Response | Promise<Response>) => (await r).text();

test('fills each placeholder from the app in-process', async () => {
  const get = await app({ dir: appBuild(), data: { feed: 'skip' } });
  const res = await get('/?tag=rust%20lang&x=1', { headers: { cookie: 's=1' } });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(res.headers.get('cache-control')).toBe('private, no-cache');
  const html = await res.text();
  // `$url.tag` into the template, encoded as the browser would; the cookie forwarded; `<` escaped
  expect(html).toContain(E('<script type="application/json" data-sn="3">{"articles":[{"title":"‹/script>‹b>x"}],"q":"tag=rust%20lang&limit=10","who":"s=1"}</script>'));
  expect(html).toContain('<script type="application/json" data-sn="4">{"tags":["a"]}</script>');
  // a `when`: left to the browser
  expect(html).toContain('<script type="application/json" data-sn="5"></script>');
  expect(html.startsWith(HEAD) && html.endsWith('<main></main></body></html>')).toBe(true);
  // no tag: the parameter is left out
  expect(await text(get('/'))).toContain('"q":"limit=10"');
  // path parameters; a failing request (the comments answer 500) ends the page with the error text
  const article = await get('/article/hello%20world');
  expect(article.status).toBe(200);
  const a = await article.text();
  expect(a).toContain('data-sn="0">{"article":{"slug":"hello world"}}</script>');
  expect(a.endsWith('<script type="application/json" data-sn="1"></script></head><body data-sn-failed><p>Error, please retry later.</p></body></html>')).toBe(true);
});

test('other requests go to the app', async () => {
  const get = await app({ dir: appBuild(), data: { feed: 'skip' } });
  expect(await text(get('/assets/app.css'))).toBe('static file');
  expect(await text(get('/article/a/b'))).toBe('static file');
  expect(await text(get('/', { method: 'POST' }))).toBe('static file');
  expect(await text(get('/api/tags'))).toBe('{"tags":["a"]}');
  // the manifest and its types are not served
  expect((await get('/sinter-embed.json')).status).toBe(404);
  expect((await get('/sinter-embed.d.ts')).status).toBe(404);
  // HEAD: the page's headers, no body, no requests
  const head = await get('/', { method: 'HEAD' });
  expect([head.status, await head.text(), head.headers.get('content-type')]).toEqual([200, '', 'text/html; charset=utf-8']);
});

test('a resolver takes precedence and gets what the template cannot express', async () => {
  const get = await app({
    dir: appBuild(),
    data: {
      feed: (r) => {
        expect([r.page, r.url]).toEqual(['index.html', '/api/feed']);
        const user = r.request.headers.get('cookie');
        return user ? { feed: user, page: r.params.page ?? '1' } : null;
      },
      tags: () => '{"tags":["mine"]}',
    },
  });
  const html = await text(get('/?page=2', { headers: { cookie: 'u=7' } }));
  expect(html).toContain('data-sn="5">{"feed":"u=7","page":"2"}</script>');
  expect(html).toContain('data-sn="4">{"tags":["mine"]}</script>');
  // signed out: the resolver leaves it to the browser
  expect(await text(get('/'))).toContain('<script type="application/json" data-sn="5"></script>');
});

test('the head is sent before the data, and slow data ends the page at the time limit', async () => {
  let release!: () => void;
  const released = new Promise<void>((ok) => (release = ok));
  const get = await app({
    dir: appBuild(),
    data: { feed: 'skip', article: async () => { await released; return {}; }, comments: () => new Promise((ok) => setTimeout(() => ok([]), 5000)) },
    timeout: 300,
  });
  const t = performance.now();
  const reader = (await get('/article/x')).body!.getReader();
  // the first chunk: everything before the first placeholder, while its data is still pending
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toBe(`${HEAD}<script type="application/json" data-sn="0">`);
  expect(performance.now() - t).toBeLessThan(100);
  release();
  let rest = '';
  for (let r = await reader.read(); !r.done; r = await reader.read()) rest += new TextDecoder().decode(r.value);
  expect(rest).toBe('{}</script><script type="application/json" data-sn="1"></script></head><body data-sn-failed><p>Error, please retry later.</p></body></html>');
  // the slow one waited for the time limit, not for itself (it ignores its signal)
  const took = performance.now() - t;
  expect(took).toBeGreaterThanOrEqual(290);
  expect(took).toBeLessThan(2000);
});

test('a paginated resource is requested at its first page', async () => {
  const dir = build(`{ "version": 2, "pages": [ { "file": "index.html", "paths": ["/tag/:tag"], "data": [
    { "id": 0, "resource": "articles", "src": ["/api/articles?tag=", { "url": "tag" }], "query": [["page", "1"], ["limit", "10"]] } ] } ] }`,
  { 'index.html': '<head><script type="application/json" data-sn="0"></script></head>' });
  // the page's `$url` in the template, then the pager's first-page parameters, as the runtime writes them
  expect(await text((await app({ dir }))('/tag/a%20b'))).toContain('"q":"tag=a+b&page=1&limit=10"');
});

test('an array parameter is a list: repeated keys in the request, a list in the resolver\'s params', async () => {
  const dir = build(`{ "version": 2, "pages": [ { "file": "index.html", "paths": ["/"], "arrays": ["tag"], "data": [
    { "id": 0, "resource": "articles", "src": ["/api/articles?tag=", { "url": "tag" }, "&limit=10"] },
    { "id": 1, "resource": "seen", "src": ["/api/seen"] } ] } ] }`,
  { 'index.html': '<head><script type="application/json" data-sn="0"></script><script type="application/json" data-sn="1"></script></head>' });
  let params: unknown;
  const get = await app({ dir, data: { seen: (r) => { params = r.params; return {}; } } });
  expect(await text(get('/?tag=a&tag=b%20c&x=1&x=2'))).toContain('"q":"tag=a&tag=b%20c&limit=10"');
  expect(params).toEqual({ tag: ['a', 'b c'], x: '2' });
  // none: the parameter is left out, and the list is empty
  expect(await text(get('/'))).toContain('"q":"limit=10"');
  expect(params).toEqual({ tag: [] });
});

test('unstreamed, the page is one piece and a failure is its status', async () => {
  const get = await app({ dir: appBuild(), data: { feed: 'skip' }, stream: false });
  const res = await get('/');
  const html = await res.text();
  expect(res.status).toBe(200);
  expect(Number(res.headers.get('content-length'))).toBe(new TextEncoder().encode(html).length);
  expect(html.endsWith('<main></main></body></html>')).toBe(true);
  // the comments answer 500: a 502 with the error text instead of the page
  const failed = await get('/article/x');
  expect(failed.status).toBe(502);
  expect(await failed.text()).toBe('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body data-sn-failed><p>Error, please retry later.</p></body></html>');
  // out of time: 504
  const slow = await app({ dir: appBuild(), data: { feed: 'skip', tags: () => new Promise(() => {}) }, stream: false, timeout: 50 });
  expect((await slow('/')).status).toBe(504);
});

test('a failure redirects to the error page when there is one', async () => {
  const get = await app({ dir: appBuild(), data: { feed: 'skip' }, errorRedirect: '/error?from="x"<', errorText: 'Try again <soon>' });
  const tail = (await text(get('/article/x'))).split('data-sn="1">')[1];
  expect(tail).toBe(E('</script><meta http-equiv="refresh" content="0;url=/error?from=&quot;x&quot;&lt;"><script>location.replace("/error?from=\\"x\\"‹")</script></head><body data-sn-failed><p>Try again &lt;soon&gt;</p></body></html>'));
});

test('data left to the browser is no failure', async () => {
  // a resolver's null, a skip, a `when` that does not hold: the page is sent whole, those placeholders empty
  const get = await app({ dir: appBuild(), data: { feed: 'skip', comments: () => undefined } });
  expect((await text(get('/article/x'))).endsWith('<script type="application/json" data-sn="1"></script></head><body></body></html>')).toBe(true);
});

test('what a resolver returns: a value, a JSON text, bytes, a Response; a throw, a non-JSON or a too large response fails', async () => {
  const dir = build(`{ "version": 2, "pages": [ { "file": "index.html", "paths": ["/"], "data": [ { "id": 0, "resource": "a", "src": null } ] } ] }`,
    { 'index.html': '<head><script type="application/json" data-sn="0"></script></head>' });
  const one = async (a: (r: unknown) => unknown, more: Partial<EmbedOptions> = {}) => text((await app({ dir, data: { a }, ...more }))('/'));
  expect(await one(() => ({ x: '</' }))).toContain(E('data-sn="0">{"x":"‹/"}</script>'));
  expect(await one(() => '[1]')).toContain('data-sn="0">[1]</script>');
  expect(await one(() => new TextEncoder().encode('[2]'))).toContain('data-sn="0">[2]</script>');
  expect(await one(() => new TextEncoder().encode('[3]').buffer)).toContain('data-sn="0">[3]</script>');
  expect(await one(() => json('[4]'))).toContain('data-sn="0">[4]</script>');
  for (const bad of [() => { throw Error('no'); }, () => new Response('x'), () => json('[404]', 404)]) expect(await one(bad)).toContain('data-sn-failed');
  expect(await one(() => json('[1,2,3,4,5,6]'), { maxBytes: 5 })).toContain('data-sn-failed');
});

describe('upstream and allowed origins', () => {
  let server: Server;
  afterAll(() => server?.close());
  test('same-origin paths through the upstream with the cookie; allowed origins without; others refused at startup', async () => {
    // the API on a real socket
    server = createServer(async (req, res) => {
      const r = await api(new Request('http://x' + req.url, { headers: req.headers as Record<string, string> }));
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(await r.text());
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const dir = build(`{ "version": 2, "pages": [ { "file": "index.html", "paths": ["/"], "data": [
      { "id": 0, "resource": "a", "src": ["/api/articles?tag=", { "url": "tag" }] },
      { "id": 1, "resource": "b", "src": ["${base}/api/tags"] },
      { "id": 2, "resource": "c", "src": ["${base}/api/articles"] },
      { "id": 3, "resource": "d", "src": ["http://elsewhere.invalid/api/tags"] },
      { "id": 4, "resource": "e", "src": [{ "url": "next" }] } ] } ] }`,
    { 'index.html': '<head><script type="application/json" data-sn="0"></script><script type="application/json" data-sn="1"></script><script type="application/json" data-sn="2"></script><script type="application/json" data-sn="3"></script><script type="application/json" data-sn="4"></script></head>' });
    // another origin, or a URL whose origin a value makes up: refused at startup
    const err = await embed({ dir, upstream: base, origins: [base] }).catch((e: Error) => e.message);
    expect(err).toContain('2 placeholder(s) have no source');
    expect(err).toContain('index.html: `d`: `http://elsewhere.invalid/api/tags…` is on an origin not allowed with `origins`');
    expect(err).toContain('index.html: `e`:');
    const get = await app({ dir, upstream: base, origins: [base], data: { d: 'skip', e: 'skip' } }, () => new Response('the app, not called'));
    const html = await text(get('/?tag=t&next=http%3A%2F%2Fevil.invalid%2F', { headers: { cookie: 's=1' } }));
    expect(html).toContain('"q":"tag=t","who":"s=1"');
    expect(html).toContain('data-sn="1">{"tags":["a"]}</script>');
    expect(html).toContain(E('data-sn="2">{"articles":[{"title":"‹/script>‹b>x"}],"q":"","who":"-"}</script>'));
    expect(html).toContain('<script type="application/json" data-sn="3"></script>');
    expect(html).toContain('<script type="application/json" data-sn="4"></script>');
  });
});

test('a page from another build is refused', async () => {
  const stale = build(`{ "version": 2, "pages": [ { "file": "index.html", "paths": ["/"], "data": [ { "id": 9, "resource": "a", "src": null } ] } ] }`,
    { 'index.html': '<head><script type="application/json" data-sn="1"></script></head>' });
  await expect(embed({ dir: stale, data: { a: 'skip' } })).rejects.toThrow('no placeholder for `a`');
  const filled = build(`{ "version": 2, "pages": [ { "file": "index.html", "paths": ["/"], "data": [ { "id": 1, "resource": "a", "src": null } ] } ] }`,
    { 'index.html': '<head><script type="application/json" data-sn="1">{}</script></head>' });
  await expect(embed({ dir: filled, data: { a: 'skip' } })).rejects.toThrow('not empty');
  await expect(embed({ dir: join(root, 'none') })).rejects.toThrow('sinter-embed.json');
  await expect(embed({ dir: build('{ "version": 1, "pages": [] }') })).rejects.toThrow('version 1 (this layer reads version 2');
});

test('startup refuses placeholders without a source and names that are not placeholders', async () => {
  // `feed` has a `when` only the browser evaluates
  const err = await embed({ dir: appBuild(), data: { artcles: () => null } }).catch((e: Error) => e.message);
  for (const want of [
    '`artcles`: no page of the build has a placeholder for it',
    "index.html: `feed`: its `when` is a condition only the browser can evaluate; add `feed: (req) => …` or `feed: 'skip'` to `data`",
  ]) expect(err).toContain(want);
  // a page-qualified name covers that page's placeholder
  await expect(embed({ dir: appBuild(), data: { 'index.html:feed': 'skip' } })).resolves.toBeDefined();
  await expect(embed({ dir: appBuild(), data: { 'article.html:feed': 'skip' } })).rejects.toThrow();
});

test('`when` and `page-model` are evaluated from the URL', async () => {
  const dir = build(`{ "version": 2, "pages": [ { "file": "index.html", "paths": ["/"], "data": [
    { "id": 0, "resource": "articles", "src": ["/api/articles?tag=", { "url": "tag" }], "when": { "url": "feed", "ne": "following" },
      "query": [["offset", "0"], ["limit", "10"]],
      "start": { "url": "page", "key": "offset", "size": 10, "skip": true, "query": [["offset", "10"], ["limit", "10"]] } } ] } ] }`,
  { 'index.html': '<head><script type="application/json" data-sn="0"></script></head>' });
  const get = await app({ dir });
  const q = async (p: string) => /"q":"([^"]*)"/.exec(await text(get(p)))?.[1];
  expect(await q('/?tag=x')).toBe('tag=x&offset=0&limit=10');
  expect(await q('/?page=3')).toBe('offset=20&limit=10');
  expect(await q('/?page=abc')).toBe('offset=0&limit=10');
  // `when` does not hold: no request, the placeholder empty
  expect(await text(get('/?feed=following'))).toContain('<script type="application/json" data-sn="0"></script>');
});

test("follows the site's rules: 301s and rewrites", async () => {
  const dir = build(`{ "version": 2, "pages": [
    { "file": "article.html", "paths": ["/article/:slug"], "data": [ { "id": 0, "resource": "article", "src": ["/api/articles/", { "url": "slug" }] } ] } ],
    "routes": [
      { "from": "/about.html", "to": "/about/", "status": 301 },
      { "from": "/support", "to": "/help", "status": 200, "file": "help.html" },
      { "from": "/article/:slug", "to": "/article", "status": 200, "file": "article.html" } ] }`,
  { 'article.html': `${HEAD}<script type="application/json" data-sn="0"></script></head><body></body></html>` });
  // the app echoes the path it is asked for, as the static files would serve that file
  const get = await app({ dir }, (req) => (new URL(req.url).pathname.startsWith('/api/') ? api(req) : new Response(`file ${new URL(req.url).pathname}${new URL(req.url).search}`)));
  const moved = await get('/about.html?x=1');
  expect([moved.status, moved.headers.get('location')]).toEqual([301, '/about/?x=1']);
  expect(await text(get('/support?q=2'))).toBe('file /help.html?q=2');
  const page = await get('/article/hello');
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('{"article":{"slug":"hello"}}');
  expect(await text(get('/about/'))).toBe('file /about/');
});

test("sends an unprefixed URL to the visitor's language", async () => {
  const dir = build(`{ "version": 2, "pages": [],
    "routes": [
      { "from": "/docs/about.html", "to": "/docs/about/", "status": 200, "file": "about.html", "choose": true },
      { "from": "/docs/about/", "to": "/docs/about/", "status": 200, "file": "about/index.html", "choose": true },
      { "from": "/docs/article/:slug", "to": "/docs/article", "status": 200, "file": "article.html", "choose": true } ],
    "locales": { "base": "en", "list": ["en", "de"], "at": "/docs/" } }`);
  const get = await app({ dir });
  const go = (headers: Record<string, string>, path: string) => get(path, { headers });
  const r = await go({ cookie: 'x=1; locale=de', 'accept-language': 'en' }, '/docs/article/hello?ref=x');
  expect([r.status, r.headers.get('location'), r.headers.get('vary')]).toEqual([302, '/docs/de/article/hello?ref=x', 'Cookie, Accept-Language']);
  expect((await go({ 'accept-language': 'fr-FR, de-AT;q=0.8' }, '/docs/about/')).headers.get('location')).toBe('/docs/de/about/');
  expect((await go({ 'accept-language': 'fr' }, '/docs/about/')).headers.get('location')).toBe('/docs/en/about/');
  // the old file URL: straight to the page in the language, one hop
  expect((await go({ cookie: 'locale=de' }, '/docs/about.html?x=1')).headers.get('location')).toBe('/docs/de/about/?x=1');
  expect(await text(get('/docs/de/about/'))).toBe('static file');
});

test('a Worker: the manifest and pages without a file system, `env` passed on to the app', async () => {
  const manifest = { version: 2, pages: [{ file: 'index.html', paths: ['/'], data: [{ id: 0, resource: 'tags', src: ['/api/tags'] }] }] };
  const e = await embed({ manifest, read: (f) => ({ 'index.html': '<head><script type="application/json" data-sn="0"></script></head>' })[f]! });
  const worker = { fetch: e.wrap((req: Request, env: { tags: string }) => json(`{"tags":["${env.tags}"]}`)) };
  expect(await text(worker.fetch(new Request('http://w.test/'), { tags: 'from env' }))).toContain('data-sn="0">{"tags":["from env"]}</script>');
  // as a step in a chain: `fetch(request, next)`, the next handler as the API
  expect(await text(e.fetch(new Request('http://w.test/'), () => json('{"next":1}')))).toContain('data-sn="0">{"next":1}</script>');
});

test('escape: every `<`, at the start, the end and in a row, and nothing copied without one', async () => {
  const { escape } = await import('../../src/server.js');
  const s = (v: string) => new TextDecoder().decode(escape(new TextEncoder().encode(v)));
  expect(s('<a<<b<')).toBe(E('‹a‹‹b‹'));
  expect(s('"x"')).toBe('"x"');
  const plain = new TextEncoder().encode('{"a":1}');
  expect(escape(plain)).toBe(plain);
  // a view into a larger buffer, as a response's chunk can be
  const big = new TextEncoder().encode('xx<yy');
  expect(new TextDecoder().decode(escape(big.subarray(1, 4)))).toBe(E('x‹y'));
});

test('pages and rules match in the manifest\'s order, with or without a trailing slash', async () => {
  const dir = build(`{ "version": 2, "pages": [
    { "file": "a.html", "paths": ["/article/:slug"], "data": [ { "id": 0, "resource": "a", "src": null } ] },
    { "file": "b.html", "paths": ["/article/new", "/about/"], "data": [ { "id": 0, "resource": "b", "src": null } ] } ],
    "routes": [ { "from": "/x.html", "to": "/x/", "status": 301 }, { "from": "/x.html", "to": "/y/", "status": 301 } ] }`,
  { 'a.html': '<head><script type="application/json" data-sn="0"></script></head>A', 'b.html': '<head><script type="application/json" data-sn="0"></script></head>B' });
  const get = await app({ dir, data: { a: () => '1', b: () => '2' } });
  expect(await text(get('/article/new'))).toMatch(/A$/);
  expect(await text(get('/about'))).toMatch(/B$/);
  expect(await text(get('//about/'))).toMatch(/B$/);
  expect((await get('/x.html')).headers.get('location')).toBe('/x/');
  // a redirect is for exactly its path
  expect(await text(get('/x.html/'))).toBe('static file');
});

test("a visitor who goes away aborts the page's requests (the body's cancel)", async () => {
  const dir = build(`{ "version": 2, "pages": [ { "file": "index.html", "paths": ["/"], "data": [ { "id": 0, "resource": "a", "src": null } ] } ] }`,
    { 'index.html': '<head><script type="application/json" data-sn="0"></script></head>' });
  let aborted!: (reason: unknown) => void;
  const seen = new Promise((ok) => (aborted = ok));
  const get = await app({ dir, timeout: 5000, data: { a: (r) => new Promise(() => r.signal.addEventListener('abort', () => aborted(r.signal.reason))) } });
  const reader = (await get('/')).body!.getReader();
  await reader.read(); // the head
  await reader.cancel();
  expect(String(await seen)).toContain('the visitor went away');
});

test('the static headers of the resource\'s API (`sinter({ apis })`) go with its request', async () => {
  const dir = build(`{ "version": 2, "pages": [ { "file": "index.html", "paths": ["/"], "data": [
    { "id": 0, "resource": "v", "src": ["/api/version"], "headers": { "X-Api": "2" } } ] } ] }`, {
    'index.html': `${HEAD}<script type="application/json" data-sn="0"></script></head><body></body></html>`,
  });
  const get = await app({ dir }, (req) => json(`{"x":"${req.headers.get('x-api') ?? '-'}"}`));
  expect(await text(get('/'))).toContain('<script type="application/json" data-sn="0">{"x":"2"}</script>');
});
