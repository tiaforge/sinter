// Axes (docs/proposals/axes.md): `data-sn-for` on `<html>` as a list, outer first; each item a constant of the page,
// in `file:` paths, its segment before the page's paths; a compile without `axes` lists each axis's entries.
import { expect, test } from 'vitest';
import { compile, type CompileOptions } from '../../src/compiler/index.js';

const files: Record<string, string> = {
  '/app/content/acme/posts/a.md': '---\ntitle: Acme A\n---\n',
  '/app/content/globex/posts/b.md': '---\ntitle: Globex B\n---\n',
};
const collections = new Map([['tenants', { key: 'key', value: [{ key: 'acme', name: 'Acme' }, { key: 'globex', name: 'Globex' }] }]]);
const base: CompileOptions = {
  file: '/app/blog/post.html', root: '/app', dev: false, prerender: true, moduleSrc: '/m.js', collections,
  readFile: (p) => { const t = files[p]; if (t === undefined) throw new Error('no ' + p); return t; },
  listFiles: (d) => Object.keys(files).filter((f) => f.startsWith(d)),
  helpers: { module: null, names: [], namespaces: {} },
};
const page = `<!doctype html><html data-sn-for="tenant in tenants; post in posts" data-sn-path="/blog/:slug"><head><title data-sn-text="tenant.name + ': ' + post.title"></title></head><body>
<sn-resource name="tenants" src="content:tenants"></sn-resource>
<sn-resource name="posts" src="file:/content/{tenant.key}/posts/*.md"></sn-resource>
<h1 data-sn-text="tenant.name"></h1><p data-sn-text="post.title"></p></body></html>`;

test('a template compile lists each axis\'s entries, and the page\'s own entries at the first axis\'s value', () => {
  const out = compile(page, base);
  expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(out.axes).toEqual([{ name: 'tenant', of: 'tenants', src: 'content:tenants', entries: [{ key: 'acme', value: { key: 'acme', name: 'Acme' } }, { key: 'globex', value: { key: 'globex', name: 'Globex' } }] }]);
  // the posts are the first tenant's folder's
  expect(out.pages!.entries.map((e) => e.path)).toEqual(['/blog/a']);
});

test('a point: the axis\'s value and its segment, the entry of that tenant\'s list', () => {
  const tenant = { key: 'globex', name: 'Globex' };
  const out = compile(page, { ...base, axes: [{ value: tenant, key: 'globex', segment: 'globex' }], page: { value: { title: 'Globex B', slug: 'b' }, path: '/blog/b', key: 'b' } });
  expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(out.html).toContain('<title>Globex: Globex B</title>');
  expect(out.html).toContain('<h1>Globex</h1>');
  expect(out.axes).toBeUndefined();
});

test('an axis without the page\'s own entries: every item is an axis; a list that is not one is SN340', () => {
  const plain = '<!doctype html><html data-sn-for="tenant in tenants"><head><title>x</title></head><body><sn-resource name="tenants" src="content:tenants"></sn-resource><h1 data-sn-text="tenant.name"></h1></body></html>';
  const out = compile(plain, { ...base, file: '/app/index.html', axes: [{ value: { key: 'acme', name: 'Acme' }, key: 'acme', segment: 'acme' }] });
  expect(out.html).toContain('<h1>Acme</h1>');
  const bad = compile(plain.replace('src="content:tenants"', 'src="/api/tenants"'), { ...base, file: '/app/index.html' });
  expect(bad.diagnostics.map((d) => d.code)).toContain('SN340');
});

test('a layout\'s `data-sn-for` is outside the page\'s own: the layout declares the axis, the page its entries', () => {
  const layout = '<!doctype html><html lang="en" data-sn-for="tenant in tenants"><head><title data-sn-text="tenant.name"></title></head><body><sn-resource name="tenants" src="content:tenants"></sn-resource><slot></slot></body></html>';
  const withLayout = { ...base, readFile: (p: string) => (p === '/app/src/layouts/shop-layout.html' ? layout : base.readFile(p)), componentNames: [] };
  const pg = '<shop-layout data-sn-path="/blog/:slug" data-sn-for="post in posts"><sn-resource name="posts" src="file:/content/{tenant.key}/posts/*.md"></sn-resource><p data-sn-text="tenant.name + \' \' + post.title"></p></shop-layout>';
  const out = compile(pg, withLayout);
  expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(out.axes?.map((a) => a.entries.map((e) => e.key))).toEqual([['acme', 'globex']]);
  expect(out.pages!.entries.map((e) => e.path)).toEqual(['/blog/a']);
  // a page that uses the layout without entries of its own is built once per tenant
  const plain = compile('<shop-layout><p data-sn-text="tenant.name"></p></shop-layout>', { ...withLayout, file: '/app/about.html', axes: [{ value: { key: 'globex', name: 'Globex' }, key: 'globex', segment: 'globex' }] });
  expect(plain.html).toContain('<p>Globex</p>');
  expect(plain.html).toContain('<title>Globex</title>');
});

test('a link in a row of a loop over an axis list is marked with the row\'s entry, for the build\'s link pass', () => {
  const portal = '<!doctype html><html><head><title>x</title></head><body><sn-resource name="tenants" src="content:tenants"></sn-resource><template data-sn-for="t in tenants"><a href="/about.html" data-sn-text="t.name"></a></template><a href="/faq.html">FAQ</a></body></html>';
  const out = compile(portal, { ...base, file: '/app/portal.html', axisLists: ['content:tenants'] });
  expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(out.html).toContain('<a href="/about.html" data-sinter-pt="content%3Atenants acme">Acme</a><a href="/about.html" data-sinter-pt="content%3Atenants globex">Globex</a><a href="/faq.html">FAQ</a>');
  // not an axis list: no mark
  expect(compile(portal, { ...base, file: '/app/portal.html' }).html).not.toContain('data-sinter-pt');
});

test('axisUrl(list, key): this page at another value of an axis, folded at build; another argument is SN301', () => {
  const plain = '<!doctype html><html data-sn-for="tenant in tenants"><head><title>x</title></head><body><sn-resource name="tenants" src="content:tenants"></sn-resource><template data-sn-for="t in tenants"><a data-sn-attr="{ href: axisUrl(tenants, t.key) }" data-sn-text="t.name"></a></template></body></html>';
  const axisUrls = { 'content:tenants': { acme: '/acme/', globex: 'https://globex.example/' } };
  const out = compile(plain, { ...base, file: '/app/index.html', axes: [{ value: { key: 'acme', name: 'Acme' }, key: 'acme', segment: 'acme' }], axisUrls });
  expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  expect(out.html).toContain('<a href="/acme/">Acme</a><a href="https://globex.example/">Globex</a>');
  const bad = compile(plain.replace('axisUrl(tenants, t.key)', "axisUrl('tenants', t.key)"), { ...base, file: '/app/index.html', axes: [{ value: { key: 'acme', name: 'Acme' }, key: 'acme', segment: 'acme' }], axisUrls });
  expect(bad.diagnostics.map((d) => `${d.code} ${d.message}`)).toContainEqual(expect.stringMatching(/^SN301 `axisUrl\(\)` takes the list of one of this page's axes/));
});
