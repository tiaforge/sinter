// @vitest-environment node
// sitemap.xml (docs/static-pages.md#sitemap): with `site`, the build writes every page that may be indexed at the URL
// its canonical link names, a pattern's URLs from `sitemap.paths`, each language with its alternates; the build's line
// names what it left out.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build, createLogger, type InlineConfig } from 'vite';
import { afterAll, describe, expect, test } from 'vitest';
import sinter, { type SinterOptions } from '../../src/vite.js';
import { canonicalOf, fillPattern, noindex, sitemapFiles, sitemapOf, urlset } from '../../src/sitemap-build.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const page = (title: string, html = '<html lang="en">', head = '') => `<!doctype html>${html}<head><meta charset="utf-8"><title>${title}</title>${head}</head><body><h1>${title}</h1></body></html>`;

/** builds `files` with `options`; the output folder, and the lines the build logged */
async function site(files: Record<string, string>, options: SinterOptions, config: InlineConfig = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sinter-sitemap-'));
  roots.push(root);
  for (const [f, text] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), text); }
  const out = join(root, 'dist'), lines: string[] = [];
  const logger = createLogger('info', { allowClearScreen: false });
  logger.info = (m) => { lines.push(m); };
  logger.warn = (m) => { lines.push(m); };
  const input = Object.keys(files).filter((f) => f.endsWith('.html') && !f.startsWith('public/')).map((f) => join(root, f));
  await build({ root, customLogger: logger, resolve: { alias }, plugins: [sinter(options)], ...config, build: { outDir: out, emptyOutDir: true, rollupOptions: { input } } });
  return { out, lines, read: (f: string) => readFileSync(join(out, f), 'utf8'), has: (f: string) => existsSync(join(out, f)) };
}
const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);

describe('a site', () => {
  const files = {
    'index.html': page('Home'),
    'about.html': page('About'),
    'guide/install.html': page('Install'),
    'login.html': page('Sign in', '<html lang="en" data-sn-path="/docs/login">'),
    'article.html': page('Article', '<html lang="en" data-sn-path="/docs/article/:slug">'),
    'tag.html': page('Tag', '<html lang="en" data-sn-path="/docs/tag/:tag">'),
    'editor.html': page('Editor', '<html lang="en" data-sn-path="/docs/editor /docs/editor/:slug">'),
    'secret.html': page('Secret', '<html lang="en">', '<meta name="robots" content="noindex, follow">'),
    'moved.html': page('Moved', '<html lang="en">', '<link rel="canonical" href="https://other.example/moved">'),
    '404.html': page('Not found'),
  };
  const built = site(files, { site: 'https://example.com', sitemap: { paths: { '/docs/article/:slug': async () => ['hello', { slug: 'a b' }] } } }, { base: '/docs/' });

  test('every page with a fixed URL, at its URL under the base; a pattern\'s URLs from its values, encoded', async () => {
    const { read } = await built;
    expect(locs(read('sitemap.xml'))).toEqual([
      'https://example.com/docs/about/',
      'https://example.com/docs/article/hello',
      'https://example.com/docs/article/a%20b',
      'https://example.com/docs/editor',
      'https://example.com/docs/guide/install/',
      'https://example.com/docs/',
      'https://example.com/docs/login',
    ]);
    expect(read('sitemap.xml')).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">\n  <url>\n    <loc>/);
    expect(read('sitemap.xml')).not.toContain('xhtml');
  });

  test('left out, and named in the build\'s line: noindex, a canonical link elsewhere, a pattern without values, a pattern on a page with a fixed URL; 404.html', async () => {
    const { read, lines } = await built;
    expect(read('sitemap.xml')).not.toMatch(/secret|moved|404|tag\//);
    const line = lines.find((l) => l.startsWith('sinter: sitemap.xml'));
    expect(line).toBe('sinter: sitemap.xml: 7 URLs; left out: editor.html /docs/editor/:slug (its canonical link names https://example.com/docs/editor), moved.html (its canonical link names https://other.example/moved), secret.html (noindex), tag.html /docs/tag/:tag (no values in sitemap.paths)');
  });
});

test('languages: each language\'s URL, with every language and the chooser as alternates', async () => {
  const { read } = await site({
    'project.inlang/settings.json': JSON.stringify({ baseLocale: 'en', locales: ['en', 'de'] }),
    'src/sinter.content.ts': `import { languages } from '@tiaforge-ui/sinter/content';\nimport { inlang, inlangLocales } from '@tiaforge-ui/sinter/messages/content';\nexport const locales = languages(({ root }) => inlangLocales('project.inlang', root));\nexport const messages = inlang();\n`,
    'messages/en.json': JSON.stringify({ title: 'About' }),
    'messages/de.json': JSON.stringify({ title: 'Über uns' }),
    'index.html': page('Home'),
    'about.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title data-sn-text="m.title()">x</title></head><body></body></html>`,
    'article.html': page('Article', '<html lang="en" data-sn-path="/article/:slug">'),
  }, { localePrefix: true, site: 'https://example.com', sitemap: { paths: { '/article/:slug': ['hello'] } } });
  const xml = read('sitemap.xml');
  expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">');
  expect(locs(xml)).toEqual(['https://example.com/en/about/', 'https://example.com/de/about/', 'https://example.com/en/article/hello', 'https://example.com/de/article/hello', 'https://example.com/en/', 'https://example.com/de/']);
  expect(xml).toContain(`  <url>
    <loc>https://example.com/de/about/</loc>
    <xhtml:link rel="alternate" hreflang="en" href="https://example.com/en/about/"/>
    <xhtml:link rel="alternate" hreflang="de" href="https://example.com/de/about/"/>
    <xhtml:link rel="alternate" hreflang="x-default" href="https://example.com/about/"/>
  </url>`);
  expect(xml).toContain(`    <loc>https://example.com/en/article/hello</loc>
    <xhtml:link rel="alternate" hreflang="en" href="https://example.com/en/article/hello"/>
    <xhtml:link rel="alternate" hreflang="de" href="https://example.com/de/article/hello"/>
    <xhtml:link rel="alternate" hreflang="x-default" href="https://example.com/article/hello"/>`);
}, 60_000);

describe('no sitemap', () => {
  test('without `site`; with `sitemap: false`; the app\'s own public/sitemap.xml is kept', async () => {
    expect((await site({ 'index.html': page('Home') }, {})).has('sitemap.xml')).toBe(false);
    expect((await site({ 'index.html': page('Home') }, { site: 'https://example.com', sitemap: false })).has('sitemap.xml')).toBe(false);
    const own = await site({ 'index.html': page('Home'), 'public/sitemap.xml': '<urlset>mine</urlset>' }, { site: 'https://example.com' });
    expect(own.read('sitemap.xml')).toBe('<urlset>mine</urlset>');
    expect(own.lines).toContain("sinter: sitemap.xml: the app's own (public/sitemap.xml) is kept");
  });

  test('with a relative base: the build does not know the URLs', async () => {
    const r = await site({ 'index.html': page('Home') }, { site: 'https://example.com' }, { base: './' });
    expect(r.has('sitemap.xml')).toBe(false);
    expect(r.lines).toContain('sinter: no sitemap.xml with a relative base: the build does not know the URLs the site is served at');
  });
});

describe('mistakes in `paths` fail the build', () => {
  const files = { 'index.html': page('Home'), 'article.html': page('Article', '<html lang="en" data-sn-path="/article/:slug">') };
  test('a pattern no page has', async () => {
    await expect(site(files, { site: 'https://example.com', sitemap: { paths: { '/articles/:slug': ['x'] } } })).rejects.toThrow('sinter({ sitemap: { paths } }): no page has the pattern `/articles/:slug`; the patterns with parameters are `/article/:slug`');
  });
  test('a value that does not fill the pattern; a function that returns no list', async () => {
    await expect(site(files, { site: 'https://example.com', sitemap: { paths: { '/article/:slug': [{ id: 'x' }] } } })).rejects.toThrow('article.html: `/article/:slug` has no parameter `id` (it has `slug`)');
    await expect(site(files, { site: 'https://example.com', sitemap: { paths: { '/article/:slug': (() => 'x') as never } } })).rejects.toThrow('`/article/:slug` returned "x", not a list of values');
  });
  test('the option itself', () => {
    expect(() => sinter({ sitemap: { paths: { '/article/:slug': ['x'] } } })).toThrow("sinter({ sitemap }): a sitemap names absolute URLs, so it needs the site's origin: add `site: 'https://…'`");
    expect(() => sinter({ site: 'https://example.com', sitemap: { paths: { '/about': ['x'] } } })).toThrow('`/about` is not a pattern with parameters');
    expect(() => sinter({ site: 'https://example.com', sitemap: { pages: [] } as never })).toThrow('sinter({ sitemap }): no option `pages`; it takes `paths`');
  });
});

describe('the parts', () => {
  test('fillPattern: by name or one string, each value a path segment', () => {
    expect(fillPattern('/blog/:year/:slug', { year: '2026', slug: 'a/b' })).toBe('/blog/2026/a%2Fb');
    expect(fillPattern('/article/:slug', 'hello')).toBe('/article/hello');
    expect(fillPattern('/blog/:year/:slug', 'x')).toEqual({ error: 'a string fills a pattern with one parameter; `/blog/:year/:slug` has 2: give `{ year: …, slug: … }`' });
    expect(fillPattern('/blog/:year/:slug', { year: '2026' })).toEqual({ error: 'the value for `/blog/:year/:slug` has no `slug`: {"year":"2026"}' });
    expect(fillPattern('/article/:slug', { slug: '' })).toEqual({ error: '`slug` is empty in a value for `/article/:slug`: that URL is not the page\'s' });
  });

  test('noindex and canonicalOf read the head, not templates or the body', () => {
    expect(noindex('<head><meta name="robots" content="noindex"></head>')).toBe(true);
    expect(noindex('<head><meta content="NONE" name="ROBOTS"></head>')).toBe(true);
    expect(noindex('<head><meta name="robots" content="index, follow"></head>')).toBe(false);
    expect(noindex('<head><template><meta name="robots" content="noindex"></template></head>')).toBe(false);
    expect(noindex('<head></head><body><meta name="robots" content="noindex"></body>')).toBe(false);
    expect(canonicalOf('<head><link rel="canonical" href="https://a.example/x?a=1&amp;b=2"></head>')).toBe('https://a.example/x?a=1&b=2');
    expect(canonicalOf('<head><link rel="canonical" data-sn-attr="{ href: $canonical }"></head>')).toBe(null);
  });

  test('urlset escapes; past the limit, a sitemap index and its files', () => {
    expect(urlset([{ loc: 'https://e.example/?a=1&b=2' }])).toContain('<loc>https://e.example/?a=1&amp;b=2</loc>');
    const files = sitemapFiles([1, 2, 3].map((i) => ({ loc: `https://e.example/${i}` })), 'https://e.example/', 2);
    expect(files.map((f) => f.fileName)).toEqual(['sitemap.xml', 'sitemap-1.xml', 'sitemap-2.xml']);
    expect(files[0]!.source).toContain('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <sitemap>\n    <loc>https://e.example/sitemap-1.xml</loc>');
    expect(locs(files[2]!.source)).toEqual(['https://e.example/3']);
  });

  test('sitemapOf', () => {
    expect(sitemapOf(undefined, null)).toEqual({});
    expect(sitemapOf(false, 'https://e.example')).toBe(false);
    expect(() => sitemapOf('yes', null)).toThrow('sinter({ sitemap }): takes `false` or `{ paths }`');
  });
});
