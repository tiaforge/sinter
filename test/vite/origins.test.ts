// @vitest-environment node
// Axes with origins (docs/proposals/axes.md §6, step 6.2): a tenant whose entry has an `origin` is written under its
// key's folder, and every URL in its pages is that domain's: links, the canonical link, `hreflang`, the sitemap (one
// per origin, at its folder's root), the next-page data; a tenant without one is a path segment on `site`.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import sinter from '../../src/vite.js';

const src = resolve(__dirname, '../../src');
const alias = [{ find: /^@tiaforge-ui\/sinter\/runtime$/, replacement: `${src}/runtime-entry.ts` }, { find: /^@tiaforge-ui\/sinter\/(?:runtime\/)?(.+)$/, replacement: `${src}/$1.ts` }, { find: /^@tiaforge-ui\/sinter$/, replacement: `${src}/index.ts` }];
const root = mkdtempSync(join(tmpdir(), 'sinter-origins-'));
const out = join(root, 'dist');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const files: Record<string, string> = {
  'src/sinter.content.ts': `import { collection, languages } from '@tiaforge-ui/sinter/content';
export const locales = languages({ base: 'en', list: ['en', 'de'] });
export const tenants = collection({ key: 'key', load: () => [
  { key: 'acme', name: 'Acme', origin: 'https://acme-shop.com' },
  { key: 'demo', name: 'Demo' },
] });
`,
  'src/layouts/shop-layout.html': `<!doctype html>
<html lang="en" data-sn-for="tenant in tenants" data-sn-props="{ title: string }">
<head><meta charset="utf-8"><title data-sn-text="tenant.name + ' · ' + title"></title></head>
<body>
  <sn-resource name="tenants" src="content:tenants"></sn-resource>
  <nav><a href="/index.html">Home</a> <a href="/about.html">About</a> <a href="/faq.html">FAQ</a></nav>
  <ol class="shops"><template data-sn-for="x in tenants"><li><a data-sn-attr="{ href: axisUrl(tenants, x.key) }" data-sn-text="x.name"></a></li></template></ol>
  <main><slot></slot></main>
</body>
</html>`,
  'index.html': `<shop-layout data-sn-with="{ title: 'Home' }"><h1 data-sn-text="tenant.name"></h1><p data-sn-text="$canonical"></p></shop-layout>`,
  'about.html': `<shop-layout data-sn-with="{ title: 'About' }"><p data-sn-text="'About ' + tenant.name"></p></shop-layout>`,
  // a page that runs: its next-page data names its origin's pages
  // pages outside the tenant axis: a portal that links to each tenant's page from a loop over them, and a shared FAQ
  'portal.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shops</title></head><body>
<sn-resource name="tenants" src="content:tenants"></sn-resource>
<ul><template data-sn-for="t in tenants"><li><a href="/about.html" data-sn-text="t.name"></a></li></template></ul>
<a href="/faq.html">FAQ</a></body></html>`,
  'faq.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>FAQ</title></head><body><a href="/portal.html">Shops</a></body></html>`,
  'cart.html': `<shop-layout data-sn-with="{ title: 'Cart' }"><sn-resource name="cart" src="/api/cart"></sn-resource><p data-sn-text="cart.n"></p></shop-layout>`,
};
beforeAll(async () => {
  for (const [f, text] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), text); }
  await build({
    root, logLevel: 'silent', resolve: { alias },
    plugins: [sinter({ localePrefix: true, typecheck: false, site: 'https://example.com' })],
    build: { outDir: out, emptyOutDir: true, rollupOptions: { input: ['index.html', 'about.html', 'cart.html', 'portal.html', 'faq.html'].map((f) => join(root, f)) } },
  });
}, 120_000);
const read = (f: string) => readFileSync(join(out, f), 'utf8');
const walk = (d: string, p = ''): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name), `${p}${e.name}/`) : [`${p}${e.name}`]));

describe('a tenant on its own domain, and one on the site', () => {
  test('the files: the domain\'s tenant under its folder, its languages inside; the other under its segment', () => {
    const html = walk(out).filter((f) => f.endsWith('.html'));
    for (const f of ['acme/en/index.html', 'acme/de/about/index.html', 'en/demo/index.html', 'de/demo/about/index.html']) expect(html, f).toContain(f);
    expect(html.some((f) => f.startsWith('en/acme/'))).toBe(false);
  });

  test('its URLs are the domain\'s: links, the canonical link, hreflang', () => {
    const de = read('acme/de/about/index.html');
    expect(de).toContain('<a href="/de/">Home</a> <a href="/de/about/">About</a>');
    expect(de).toContain('<link rel="canonical" href="https://acme-shop.com/de/about/">');
    expect(de).toContain('<link rel="alternate" hreflang="en" href="https://acme-shop.com/en/about/">');
    expect(read('acme/en/index.html')).toContain('<p>https://acme-shop.com/en/</p>');
    // the tenant on the site: its segment, on `site`
    expect(read('de/demo/about/index.html')).toContain('<link rel="canonical" href="https://example.com/de/demo/about/">');
  });

  test('the chooser at the domain\'s unprefixed URL, in its folder; a sitemap per origin', () => {
    expect(read('acme/about/index.html')).toContain('url=/en/about/');
    const own = read('acme/sitemap.xml');
    expect(own).toContain('<loc>https://acme-shop.com/de/about/</loc>');
    expect(own).not.toContain('example.com');
    const site = read('sitemap.xml');
    expect(site).toContain('<loc>https://example.com/de/demo/about/</loc>');
    expect(site).not.toContain('acme');
  });

  test('next-page data per origin: the domain\'s pages name its paths, the site\'s theirs', () => {
    const js = walk(join(out, 'assets')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(out, 'assets', f), 'utf8'));
    const lists = js.filter((c) => c.includes('/de/cart') || c.includes('/de/demo/cart'));
    // one list for the domain (no folder in its paths), one for the site
    expect(lists.some((c) => /["`']\/de\/cart\//.test(c) && !c.includes('/acme/'))).toBe(true);
    expect(lists.some((c) => c.includes('/de/demo/cart/'))).toBe(true);
    expect(lists.every((c) => !(c.includes('/de/demo/cart/') && /["`']\/de\/cart\//.test(c)))).toBe(true);
  });

  test('links across points: a loop over the tenants names each one\'s page, absolute on its domain; a tenant\'s link to a shared page, absolute on the site', () => {
    const portal = read('de/portal/index.html');
    expect(portal).toContain('<li><a href="https://acme-shop.com/de/about/">Acme</a></li><li><a href="/de/demo/about/">Demo</a></li>');
    expect(portal).toContain('<a href="/de/faq/">FAQ</a>');
    expect(portal).not.toContain('data-sinter-pt');
    // from the domain: the site's page is absolute; from the tenant on the site, a path
    expect(read('acme/de/about/index.html')).toContain('<a href="https://example.com/de/faq/">FAQ</a>');
    expect(read('de/demo/about/index.html')).toContain('<a href="/de/faq/">FAQ</a>');
    expect(read('de/faq/index.html')).toContain('<a href="/de/portal/">Shops</a>');
  });

  test('axisUrl(): this page at each tenant, absolute on another origin', () => {
    expect(read('acme/de/about/index.html')).toContain('<li><a href="/de/about/">Acme</a></li><li><a href="https://example.com/de/demo/about/">Demo</a></li>');
    expect(read('de/demo/about/index.html')).toContain('<li><a href="https://acme-shop.com/de/about/">Acme</a></li><li><a href="/de/demo/about/">Demo</a></li>');
  });

  test('a link to a tenant\'s page from a page outside the tenants, not in a loop over them, fails the build', async () => {
    writeFileSync(join(root, 'faq.html'), files['faq.html']!.replace('<a href="/portal.html">', '<a href="/about.html">About</a><a href="/portal.html">'));
    try {
      await expect(build({
        root, logLevel: 'silent', resolve: { alias },
        plugins: [sinter({ localePrefix: true, typecheck: false, site: 'https://example.com' })],
        build: { outDir: join(root, 'dist-bad'), emptyOutDir: true, rollupOptions: { input: ['about.html', 'faq.html'].map((f) => join(root, f)) } },
      })).rejects.toThrow(/faq\.html \(en\/faq\.html\): the link to `\/about\.html` goes to a page built per entry of `content:tenants`, and this page is not, nor is the link in a loop over that list/);
    } finally {
      writeFileSync(join(root, 'faq.html'), files['faq.html']!);
    }
  }, 120_000);

  test('the site\'s _redirects leave the domain\'s pages to its proxy', () => {
    if (existsSync(join(out, '_redirects'))) expect(read('_redirects')).not.toContain('acme');
  });
});
