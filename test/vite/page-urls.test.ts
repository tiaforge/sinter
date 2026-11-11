// @vitest-environment node
// Page URLs (docs/static-pages.md): every page with a fixed path is a directory's index, `about.html` as
// `about/index.html` at `/about/`; links name that URL, a redirect file keeps the old one working, and the
// dev server and `vite preview` serve the same URLs as a host does.
import { createServer as http } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { build, createServer, preview } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import sinter from '../../src/vite.js';
import { chromium } from '../browser.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const root = mkdtempSync(join(tmpdir(), 'sinter-page-urls-'));
const out = join(root, 'dist');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const page = (title: string, body: string, html = '<html lang="en">') => `<!doctype html>${html}<head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const NAV = '<nav><a href="/">Home</a> <a href="/about.html">About</a> <a href="/docs/getting-started">Start</a> <a href="/article/hello">Article</a> <a href="/login">Sign in</a></nav>';
const files: Record<string, string> = {
  'index.html': page('Home', NAV),
  'about.html': page('About', `${NAV}<img src="img/logo.svg" alt=""><a href="contact.pdf">Card</a>`),
  'docs/getting-started.html': page('Start', `${NAV}<a href="../about.html">About</a><a href="index.html">Docs</a>`),
  'docs/index.html': page('Docs', NAV),
  'article.html': page('Article', '<h1 data-sn-text="$url.slug"></h1>', '<html lang="en" data-sn-path="/article/:slug">'),
  'login.html': page('Sign in', '<form data-sn-post="/api/login"><button>Sign in</button></form>', '<html lang="en" data-sn-path="/login">'),
  '404.html': page('Not found', NAV),
  'img/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
  'public/_redirects': '/old-blog/*  https://blog.example.com/:splat  301\n',
};
const input = Object.keys(files).filter((f) => f.endsWith('.html')).map((f) => join(root, f));

beforeAll(async () => {
  for (const [f, text] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), text); }
  await build({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter()], build: { outDir: out, emptyOutDir: true, assetsInlineLimit: 0, rollupOptions: { input } } });
}, 60_000);
const read = (f: string) => readFileSync(join(out, f), 'utf8');

test('a page with a fixed path is a directory\'s index; index, 404 and pages with data-sn-path stay', () => {
  for (const f of ['about/index.html', 'docs/getting-started/index.html', 'index.html', 'docs/index.html', '404.html', 'article.html', 'login.html']) expect(existsSync(join(out, f)), f).toBe(true);
  expect(read('about/index.html')).toContain('<title>About</title>');
  // the old file sends visitors and search engines to the new URL
  expect(read('about.html')).toContain('<meta http-equiv="refresh" content="0; url=/about/">');
  expect(read('about.html')).toContain('<link rel="canonical" href="/about/">');
  expect(read('docs/getting-started.html')).toContain('url=/docs/getting-started/');
});

test('links name the pages\' URLs; a page that moved keeps its relative URLs pointing where they did', () => {
  const nav = '<nav><a href="/">Home</a> <a href="/about/">About</a> <a href="/docs/getting-started/">Start</a> <a href="/article/hello">Article</a> <a href="/login">Sign in</a></nav>';
  expect(read('index.html')).toContain(nav);
  expect(read('404.html')).toContain(nav);
  const about = read('about/index.html');
  expect(about).toContain(nav);
  expect(about).toMatch(/<img src="\/assets\/logo-[\w-]+\.svg" alt="">/);
  expect(about).toContain('<a href="../contact.pdf">Card</a>');
  expect(read('docs/getting-started/index.html')).toContain('<a href="../../about/">About</a><a href="../">Docs</a>');
});

test('_redirects: the app\'s own rules, then a 301 per old file URL and a rewrite per declared path the host does not serve anyway', () => {
  expect(read('_redirects')).toBe(`/old-blog/*  https://blog.example.com/:splat  301

# written by sinter: the pages' URLs (docs/static-pages.md#page-urls)
/about.html  /about/  301
/docs/getting-started.html  /docs/getting-started/  301
/article/:slug  /article  200
`);
});

test('sinter({ redirects: false }): no _redirects of sinter\'s', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sinter-page-urls-off-'));
  try {
    writeFileSync(join(dir, 'about.html'), page('About', '<p>a</p>'));
    await build({ root: dir, logLevel: 'silent', resolve: { alias }, plugins: [sinter({ redirects: false })], build: { outDir: join(dir, 'dist'), rollupOptions: { input: join(dir, 'about.html') } } });
    expect(existsSync(join(dir, 'dist/_redirects'))).toBe(false);
    expect(existsSync(join(dir, 'dist/about/index.html'))).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Speculation Rules name the new URLs, and patterns with or without a trailing slash', () => {
  const rules = JSON.parse(/<script type="speculationrules">(.*?)<\/script>/s.exec(read('index.html'))![1]!);
  const m = rules.prefetch[0].where.and[0].href_matches as string[];
  expect(m).toEqual(expect.arrayContaining(['/about/\\?*#*', '/about\\?*#*', '/article/:slug\\?*#*', '/article/:slug/\\?*#*', '/login\\?*#*']));
  expect(m).not.toContain('/about.html\\?*#*');
});

test('two pages for one URL fail the build', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sinter-page-urls-clash-'));
  try {
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs.html'), page('A', '<p>a</p>'));
    writeFileSync(join(dir, 'docs/index.html'), page('B', '<p>b</p>'));
    const err = await build({ root: dir, logLevel: 'silent', resolve: { alias }, plugins: [sinter()], build: { outDir: join(dir, 'dist'), rollupOptions: { input: [join(dir, 'docs.html'), join(dir, 'docs/index.html')] } } }).catch((e: Error) => e);
    expect(String(err)).toContain('docs.html is written as docs/index.html, its URL /docs/, and docs/index.html is there too');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the embed manifest names the file a page is written to', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sinter-page-urls-embed-'));
  try {
    writeFileSync(join(dir, 'feed.html'), page('Feed', '<sn-resource name="posts" src="/api/posts"></sn-resource><p data-sn-text="posts.length"></p>'));
    await build({ root: dir, logLevel: 'silent', resolve: { alias }, plugins: [sinter({ embed: true })], build: { outDir: join(dir, 'dist'), rollupOptions: { input: join(dir, 'feed.html') } } });
    const manifest = JSON.parse(readFileSync(join(dir, 'dist/sinter-embed.json'), 'utf8'));
    expect(manifest.pages[0]).toMatchObject({ file: 'feed/index.html', paths: ['/feed/', '/feed'] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the dev server serves /about/ from about.html and redirects /about and /about.html to it', async () => {
  const server = await createServer({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter()], server: { port: 0 } });
  await server.listen();
  try {
    const base = server.resolvedUrls!.local[0]!.replace(/\/$/, '');
    const about = await fetch(`${base}/about/`);
    expect(about.status).toBe(200);
    const html = await about.text();
    expect(html).toContain('<title>About</title>');
    // relative URLs resolve from /about/ as in the build
    expect(html).toContain('<a href="../contact.pdf">Card</a>');
    for (const from of ['/about', '/about.html', '/about?x=1']) {
      const r = await fetch(base + from, { redirect: 'manual' });
      expect(r.status, from).toBe(301);
      expect(r.headers.get('location'), from).toBe(from.includes('?') ? '/about/?x=1' : '/about/');
    }
    const login = await fetch(`${base}/login/`, { redirect: 'manual' });
    expect([login.status, login.headers.get('location')]).toEqual([301, '/login']);
    // pages that stay are served where they are; a declared path is its page
    expect((await fetch(`${base}/login.html`, { redirect: 'manual' })).status).toBe(200);
    const article = await fetch(`${base}/article/hello`, { redirect: 'manual' });
    expect(article.status).toBe(200);
    expect(await article.text()).toContain('<title>Article</title>');
    expect((await fetch(`${base}/docs/`, { redirect: 'manual' })).status).toBe(200);
  } finally {
    await server.close();
  }
}, 60_000);

test('vite preview serves the built URLs: /about/, and /about redirected to it', async () => {
  const server = await preview({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter()], build: { outDir: out }, preview: { port: 0 } });
  try {
    const base = server.resolvedUrls!.local[0]!.replace(/\/$/, '');
    const about = await fetch(`${base}/about/`);
    expect(about.status).toBe(200);
    expect(await about.text()).toContain('<title>About</title>');
    for (const [from, to] of [['/about', '/about/'], ['/about.html', '/about/'], ['/about.html?x=1', '/about/?x=1']]) {
      const r = await fetch(base + from, { redirect: 'manual' });
      expect(r.status, from).toBe(301);
      expect(r.headers.get('location'), from).toBe(to);
    }
    // a page that stays in its file: `/login/` to `/login`, as hosts do
    const login = await fetch(`${base}/login/`, { redirect: 'manual' });
    expect([login.status, login.headers.get('location')]).toEqual([301, '/login']);
    // a declared path is its page, as _redirects says
    const article = await fetch(`${base}/article/hello`);
    expect(article.status).toBe(200);
    expect(await article.text()).toContain('<title>Article</title>');
  } finally {
    await new Promise<void>((r) => server.httpServer.close(() => r()));
  }
}, 60_000);

test.skipIf(!chromium)('in the browser: the old URL arrives at the new one, and a moved page\'s images and links work', async () => {
  const types: Record<string, string> = { '.html': 'text/html', '.svg': 'image/svg+xml', '.css': 'text/css', '.js': 'text/javascript' };
  const host = http((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    try { res.writeHead(200, { 'content-type': types[extname(path) || '.html'] ?? 'application/octet-stream' }).end(readFileSync(join(out, path.endsWith('/') ? path + 'index.html' : path))); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise<void>((r) => host.listen(0, r));
  const browser = await chromium!.launch();
  try {
    const url = `http://localhost:${(host.address() as { port: number }).port}`;
    const tab = await browser.newPage();
    // the old URL, with a query and a fragment (a link built at run time): kept
    await tab.goto(`${url}/about.html?ref=x#top`);
    await tab.waitForURL(`${url}/about/?ref=x#top`);
    expect(await tab.title()).toBe('About');
    expect(await tab.$eval('img', (i) => (i as HTMLImageElement).naturalWidth)).toBe(1);
    await tab.click('text=Start');
    await tab.waitForURL(`${url}/docs/getting-started/`);
    expect(await tab.title()).toBe('Start');
  } finally {
    await browser.close();
    host.close();
  }
}, 60_000);

test('a link built at run time that names a moved page by its file: the build says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sinter-page-urls-warn-'));
  try {
    writeFileSync(join(dir, 'list.html'), page('List', '<div data-sn-state="{ n: 1 }"><a data-sn-attr="{ href: \'/item.html?n=\' + n }">item</a><button data-sn-on-click="n++">+</button></div>'));
    writeFileSync(join(dir, 'item.html'), page('Item', '<p>item</p>'));
    const logs: string[] = [];
    const log = (m: string) => { logs.push(m); };
    await build({ root: dir, customLogger: { info: log, warn: log, warnOnce: log, error: log, clearScreen() {}, hasErrorLogged: () => false, hasWarned: false }, resolve: { alias }, plugins: [sinter()], build: { outDir: join(dir, 'dist'), rollupOptions: { input: [join(dir, 'list.html'), join(dir, 'item.html')] } } });
    expect(logs.join('\n')).toContain('sinter: list.html builds a link to item.html at run time, which is served at /item/ now: it arrives through a redirect');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 60_000);

