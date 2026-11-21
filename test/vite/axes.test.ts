// @vitest-environment node
// Axes in a build (docs/proposals/axes.md, step 6): a layout's `data-sn-for="tenant in tenants"` builds every page that
// uses it once per tenant, under the tenant's segment, inside each language (`localePrefix`); a page's own entries
// (`file:/content/{tenant.key}/…`) are that tenant's; links stay in the page's point; a page without the layout is
// built once.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import sinter from '../../src/vite.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const root = mkdtempSync(join(tmpdir(), 'sinter-axes-'));
const out = join(root, 'dist');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const files: Record<string, string> = {
  'src/sinter.content.ts': `import { collection, languages } from '@tiaforge-ui/sinter/content';
export const locales = languages({ base: 'en', list: ['en', 'de'] });
export const tenants = collection({ key: 'key', load: () => [{ key: 'acme', name: 'Acme' }, { key: 'globex', name: 'Globex' }] });
// each tenant's products in each language, as a CMS would answer per tenant
// the shop's texts: shared, and a tenant's own over them (only what it changes)
import { inlang } from '@tiaforge-ui/sinter/messages/content';
export const messages = inlang({ per: [tenants, locales], tenantFiles: (t) => './tenants/' + t.key + '/{locale}.json' });
export const products = collection({ key: 'sku', per: [tenants, locales], load: ({ value, locale }) => [{ sku: value(tenants).key + '-1', name: value(tenants).name + ' ' + locale + ' product' }] });
`,
  'src/layouts/shop-layout.html': `<!doctype html>
<html lang="en" data-sn-for="tenant in tenants" data-sn-props="{ title: string }">
<head><meta charset="utf-8"><title data-sn-text="tenant.name + ' · ' + title"></title></head>
<body>
  <sn-resource name="tenants" src="content:tenants"></sn-resource>
  <nav><a href="/index.html">Home</a> <a href="/about.html">About</a> <a href="/portal.html">All shops</a></nav>
  <main><slot></slot></main>
</body>
</html>`,
  'index.html': `<shop-layout data-sn-with="{ title: 'Home' }"><h1 data-sn-text="tenant.name + ' (' + $locale + ')'"></h1></shop-layout>`,
  'about.html': `<shop-layout data-sn-with="{ title: 'About' }"><p data-sn-text="'About ' + tenant.name"></p></shop-layout>`,
  'shop.html': `<shop-layout data-sn-with="{ title: 'Shop' }"><sn-resource name="products" src="content:products"></sn-resource><ul><template data-sn-for="p in products"><li data-sn-text="p.name"></li></template></ul></shop-layout>`,
  'blog/post.html': `<shop-layout data-sn-path="/blog/:slug" data-sn-for="post in posts" data-sn-with="{ title: post.title }">
  <sn-resource name="posts" src="file:/content/{tenant.key}/{$locale}/*.md" key="id"></sn-resource>
  <h1 data-sn-text="post.title"></h1>
</shop-layout>`,
  // outside the tenant axis: built once per language
  'portal.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shops</title></head><body><h1>All shops</h1></body></html>`,
  'project.inlang/settings.json': JSON.stringify({ baseLocale: 'en', locales: ['en', 'de'], 'plugin.inlang.messageFormat': { pathPattern: './messages/{locale}.json' } }),
  'messages/en.json': JSON.stringify({ cart: { title: 'Cart' }, hello: 'Welcome' }),
  'messages/de.json': JSON.stringify({ cart: { title: 'Warenkorb' }, hello: 'Willkommen' }),
  'tenants/acme/de.json': JSON.stringify({ hello: 'Servus bei Acme' }),
  'cart.html': `<shop-layout data-sn-with="{ title: m.cart.title() }"><p data-sn-text="m.hello()"></p></shop-layout>`,
  'content/acme/en/hello.md': '---\nid: hello\ntitle: Acme hello\n---\n',
  'content/acme/de/hallo.md': '---\nid: hello\ntitle: Acme hallo\n---\n',
  'content/globex/en/news.md': '---\nid: news\ntitle: Globex news\n---\n',
  'content/globex/de/neues.md': '---\nid: news\ntitle: Globex Neues\n---\n',
};
beforeAll(async () => {
  for (const [f, text] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), text); }
  await build({
    root, logLevel: 'silent', resolve: { alias },
    plugins: [sinter({ localePrefix: true, messages: false, typecheck: false, site: 'https://example.com' })],
    build: { outDir: out, emptyOutDir: true, rollupOptions: { input: ['index.html', 'about.html', 'shop.html', 'cart.html', 'blog/post.html', 'portal.html'].map((f) => join(root, f)) } },
  });
}, 120_000);
const read = (f: string) => readFileSync(join(out, f), 'utf8');
const walk = (d: string, p = ''): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name), `${p}${e.name}/`) : [`${p}${e.name}`]));

describe('a tenant axis inside each language', () => {
  test('messages per tenant: the shared texts, a tenant\'s own over them, in each language', () => {
    expect(read('de/acme/cart/index.html')).toMatch(/<title>Acme · Warenkorb<\/title>[\s\S]*<p>Servus bei Acme<\/p>/);
    expect(read('de/globex/cart/index.html')).toContain('<p>Willkommen</p>');
    expect(read('en/acme/cart/index.html')).toContain('<p>Welcome</p>');
  });

  test('a collection loaded per tenant and language: each page reads its own point\'s list', () => {
    expect(read('de/globex/shop/index.html')).toContain('<li>Globex de product</li>');
    expect(read('en/acme/shop/index.html')).toContain('<li>Acme en product</li>');
    expect(read('en/acme/shop/index.html')).not.toContain('Globex');
  });

  test('the files: each page that uses the layout once per tenant and language; the portal once per language', () => {
    const html = walk(out).filter((f) => f.endsWith('.html')).sort();
    for (const f of ['en/acme/index.html', 'en/globex/index.html', 'de/acme/index.html', 'de/globex/index.html', 'en/acme/about/index.html', 'de/globex/about/index.html',
      'en/acme/blog/hello.html', 'de/acme/blog/hallo.html', 'en/globex/blog/news.html', 'de/globex/blog/neues.html', 'en/portal/index.html', 'de/portal/index.html']) expect(html, f).toContain(f);
    // a tenant's own entries only: Acme has no news
    expect(existsSync(join(out, 'en/acme/blog/news.html'))).toBe(false);
  });

  test('each page has its tenant and language as constants, in its HTML', () => {
    expect(read('de/globex/index.html')).toContain('<h1>Globex (de)</h1>');
    expect(read('en/acme/about/index.html')).toMatch(/<title>Acme · About<\/title>[\s\S]*<p>About Acme<\/p>/);
    expect(read('de/acme/blog/hallo.html')).toContain('<h1>Acme hallo</h1>');
  });

  test('links stay in the point: the tenant\'s and language\'s own pages; a page outside the axis is the language\'s', () => {
    expect(read('de/acme/about/index.html')).toContain('<a href="/de/acme/">Home</a> <a href="/de/acme/about/">About</a> <a href="/de/portal/">All shops</a>');
    expect(read('en/globex/index.html')).toContain('<a href="/en/globex/">Home</a> <a href="/en/globex/about/">About</a>');
  });

  test('the sitemap: each tenant\'s page with its own languages as alternates', () => {
    const xml = read('sitemap.xml');
    const at = xml.indexOf('<loc>https://example.com/de/globex/about/</loc>');
    expect(at).toBeGreaterThan(-1);
    const entry = xml.slice(at, xml.indexOf('</url>', at));
    expect(entry).toContain('hreflang="en" href="https://example.com/en/globex/about/"');
    expect(entry).not.toContain('acme');
  });

  test('hreflang pairs a tenant\'s page across languages; the chooser is at the tenant\'s unprefixed path', () => {
    const de = read('de/acme/about/index.html');
    expect(de).toContain('<link rel="alternate" hreflang="en" href="https://example.com/en/acme/about/">');
    expect(de).toContain('<link rel="alternate" hreflang="x-default" href="https://example.com/acme/about/">');
    expect(read('acme/about/index.html')).toContain('url=/en/acme/about/');
    // an entry's translation is the same tenant's entry with its key
    expect(read('de/acme/blog/hallo.html')).toContain('<link rel="alternate" hreflang="en" href="https://example.com/en/acme/blog/hello">');
  });
});

test('the dev server: a tenant\'s page in a language at its URL, a tenant\'s entry, the tenant\'s chooser', async () => {
  const { createServer } = await import('vite');
  const server = await createServer({ root, logLevel: 'silent', resolve: { alias }, plugins: [sinter({ localePrefix: true, messages: false, typecheck: false })], server: { port: 0 } });
  await server.listen();
  try {
    const at = server.resolvedUrls!.local[0]!.replace(/\/$/, '');
    expect(await (await fetch(`${at}/de/globex/about/`)).text()).toContain('About Globex');
    expect(await (await fetch(`${at}/de/acme/blog/hallo`)).text()).toContain('Acme hallo');
    expect(await (await fetch(`${at}/acme/about/`)).text()).toContain('url=/en/acme/about/');
  } finally {
    await server.close();
  }
}, 60_000);
